// Live editor control bridge. Connects to the loopback WS relay, registers as the
// editor, and dispatches incoming commands through handlers that call the real
// main.ts actions (so the viewport gizmo, the panel form fields, and the persisted
// form state all update together). Auto-reconnects; answers heartbeat pings.
type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface BridgeOptions {
    handlers: Record<string, Handler>;
    appVersion: string;
    project: () => string | null;
    onEvent?: (name: string, payload: unknown) => void;
    onStatus?: (connected: boolean) => void;
}

// Throw this from a handler to return the universal {error,message} shape verbatim.
export const editorError = (error: string, message: string): never => {
    throw { error, message };
};

export function startMcpBridge(opts: BridgeOptions): void {
    const url = `ws://${location.host}/editor-ws`;
    let ws: WebSocket | null = null;
    let backoff = 1000;

    const send = (obj: unknown): void => {
        try { ws?.send(JSON.stringify(obj)); } catch { /* socket gone — reconnect handles it */ }
    };

    const connect = (): void => {
        ws = new WebSocket(url);

        ws.onopen = () => {
            backoff = 1000;
            send({ type: 'register', role: 'editor', project: opts.project(), appVersion: opts.appVersion });
            opts.onStatus?.(true);
        };

        ws.onmessage = async (ev: MessageEvent) => {
            let msg: { type?: string; id?: string; name?: string; params?: Record<string, unknown>; payload?: unknown };
            try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
            if (!msg || !msg.type) return;
            if (msg.type === 'ping') return send({ type: 'pong' });
            if (msg.type === 'event' && msg.name) return opts.onEvent?.(msg.name, msg.payload);
            if (msg.type === 'cmd' && msg.name) {
                const fn = opts.handlers[msg.name];
                if (!fn) {
                    return send({ type: 'result', id: msg.id, ok: false, error: 'bad-input', message: `unknown command: ${msg.name}` });
                }
                try {
                    const data = await fn(msg.params ?? {});
                    send({ type: 'result', id: msg.id, ok: true, data: data ?? null });
                } catch (e: unknown) {
                    const err = e && typeof e === 'object' && 'error' in e
                        ? (e as { error: string; message?: string })
                        : { error: 'bad-input', message: e instanceof Error ? e.message : String(e) };
                    send({ type: 'result', id: msg.id, ok: false, error: err.error, message: err.message });
                }
            }
        };

        ws.onclose = () => {
            ws = null;
            opts.onStatus?.(false);
            // jitter so several windows don't reconnect in lockstep
            setTimeout(connect, backoff + Math.floor(backoff * 0.25 * Math.random()));
            backoff = Math.min(backoff * 2, 15000);
        };
        ws.onerror = () => { try { ws?.close(); } catch { /* onclose reconnects */ } };
    };

    connect();
}
