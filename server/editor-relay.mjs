// Bidirectional editor control channel: a WebSocket relay attached to the existing
// loopback http.Server (path /editor-ws). The running GUI registers as 'the editor';
// the MCP server reaches it through POST /api/editor/command. The relay only
// correlates by id and forwards — it never interprets command params.
//
// Protocol (JSON application frames):
//   editor->server  {type:'register', role:'editor', project?, appVersion?}
//   editor->server  {type:'pong'}
//   editor->server  {type:'result', id, ok:true, data} | {type:'result', id, ok:false, error, message}
//   server->editor  {type:'ping'}
//   server->editor  {type:'cmd', id, name, params}
//   server->editor  {type:'event', name, payload}
import { WebSocketServer } from 'ws';

// per-command round-trip timeout tiers (server side; the MCP client ceiling is >= these)
const tierFor = (name) =>
    name === 'load_into_viewport' ? 60_000 : name === 'viewport_screenshot' ? 30_000 : 5_000;

const HEARTBEAT_MS = 15_000;
const IDLE_MS = 45_000;

// Only the app's own renderer (a loopback origin) or a non-browser local client
// (no Origin header) may connect — blocks cross-site WebSocket hijacking, where a
// web page the user happens to visit opens ws://127.0.0.1/editor-ws to evict the
// real editor or intercept the command stream.
const allowOrigin = (origin) => {
    if (!origin) return true; // non-browser local client (curl, tests, native MCP host)
    try {
        const h = new URL(origin).hostname;
        return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
    } catch { return false; }
};

export function createRelay(httpServer, { port }) {
    const wss = new WebSocketServer({ server: httpServer, path: '/editor-ws', verifyClient: (info) => allowOrigin(info.origin) });
    let editor = null; // the current editor socket (newest registration wins)
    let meta = { project: null, appVersion: null, lastSeenMs: null };
    let cid = 0;
    const pending = new Map(); // correlation id -> { resolve, timer }

    // resolve every in-flight command with the given failure shape
    const failPending = (shape) => {
        for (const { resolve, timer } of pending.values()) {
            clearTimeout(timer);
            resolve({ ok: false, ...shape });
        }
        pending.clear();
    };

    wss.on('connection', (ws) => {
        let lastSeen = Date.now();
        const hb = setInterval(() => {
            if (ws.readyState !== ws.OPEN) return;
            if (Date.now() - lastSeen > IDLE_MS) { try { ws.terminate(); } catch { /* */ } return; }
            try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* */ }
        }, HEARTBEAT_MS);

        ws.on('message', (buf) => {
            let msg;
            try { msg = JSON.parse(buf.toString()); } catch { return; }
            lastSeen = Date.now();
            if (msg.type === 'register' && msg.role === 'editor') {
                if (editor && editor !== ws) {
                    // commands in flight to the outgoing editor will never get a result — fail fast
                    failPending({ kind: 'no-editor' });
                    try { editor.close(4001, 'replaced by a newer editor'); } catch { /* */ }
                }
                editor = ws;
                meta = { project: msg.project ?? null, appVersion: msg.appVersion ?? null, lastSeenMs: Date.now() };
                return;
            }
            if (msg.type === 'pong') { if (ws === editor) meta.lastSeenMs = Date.now(); return; }
            // only the CURRENT editor may resolve a pending command (a stale/impostor
            // socket can't poison results meant for the registered editor)
            if (msg.type === 'result' && msg.id != null && ws === editor) {
                const p = pending.get(String(msg.id));
                if (p) { pending.delete(String(msg.id)); clearTimeout(p.timer); p.resolve(msg); }
            }
        });

        ws.on('close', () => {
            clearInterval(hb);
            if (ws === editor) { editor = null; failPending({ kind: 'no-editor' }); }
        });
        ws.on('error', () => { /* close handler cleans up */ });
    });

    const isConnected = () => !!editor && editor.readyState === editor.OPEN;

    // forward a command to the editor; resolves with the editor's {ok,...} result,
    // or {ok:false, kind:'no-editor'|'timeout'} for relay-level failures.
    const sendCommand = (name, params, timeoutMs) =>
        new Promise((resolve) => {
            if (!isConnected()) return resolve({ ok: false, kind: 'no-editor' });
            const id = String(++cid);
            const timer = setTimeout(() => {
                pending.delete(id);
                resolve({ ok: false, kind: 'timeout' });
            }, timeoutMs ?? tierFor(name));
            pending.set(id, { resolve, timer });
            try {
                editor.send(JSON.stringify({ type: 'cmd', id, name, params: params ?? {} }));
            } catch (err) {
                pending.delete(id);
                clearTimeout(timer);
                resolve({ ok: false, kind: 'send-failed', message: err.message });
            }
        });

    // push a server event to the editor (best-effort; powers live reflection)
    const broadcast = (name, payload) => {
        if (!isConnected()) return;
        try { editor.send(JSON.stringify({ type: 'event', name, payload })); } catch { /* */ }
    };

    // the editor binding as reported by /api/editor/status
    const status = () => ({
        connected: isConnected(),
        editorProject: meta.project,
        appVersion: meta.appVersion,
        lastSeenMs: meta.lastSeenMs,
        port
    });

    return { sendCommand, broadcast, status, isConnected };
}
