// MCP server e2e: boots the Express server on a throwaway workspace, spawns the
// stdio MCP server via the SDK client, and drives the headless tools, the editor
// relay/consent contract, and the editor-tool forwarding (with a mock WS editor).
// Run: node tests/mcp-e2e.mjs   (set SKIP_GPU=1 — not needed here, no GPU ops).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
// Resolve the SDK through mcp-server's own dependency tree via its export map —
// no hardcoded dist/ paths that break on SDK repackaging.
const sdkRequire = createRequire(new URL('../mcp-server/index.mjs', import.meta.url));
const sdkImport = (sub) => import(pathToFileURL(sdkRequire.resolve(`@modelcontextprotocol/sdk/${sub}`)).href);
const { Client } = await sdkImport('client/index.js');
const { StdioClientTransport } = await sdkImport('client/stdio.js');
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(repo, 'mcp-server', 'index.mjs');
const DEMO = path.join(repo, 'docs', '.capture-workspace', 'Demo room', 'demo-room.ply');

let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => r?.content?.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
const data = (r) => { try { return JSON.parse(text(r)); } catch { return {}; } };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
async function check(name, fn) { try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; } }
async function waitHealth(port) { for (let i = 0; i < 120; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return; } catch { /* */ } await sleep(150); } throw new Error('server never healthy'); }

const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// Fake editor on the relay WS: answers pings, screenshots with a 1px PNG, echoes
// every other command back as { ok:true, data:{ echo:{name,params} } }.
function mockEditor(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/editor-ws`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', role: 'editor', project: 'Demo', appVersion: 't' })));
    ws.on('message', (buf) => {
        const m = JSON.parse(buf.toString());
        if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
        if (m.type !== 'cmd') return;
        if (m.name === 'select_item' && m.params.id) return ws.send(JSON.stringify({ type: 'result', id: m.id, ok: false, error: 'not-found', message: 'no such item' }));
        if (m.name === 'viewport_screenshot') return ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data: { png: PNG1, width: 1, height: 1 } }));
        ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data: { name: m.name, params: m.params } }));
    });
    return ws;
}

let server, client, ed;
try {
    const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcp-e2e-'));
    await fsp.mkdir(path.join(ws, 'Demo'), { recursive: true });
    // fixture: reuse the capture-workspace copy if present, else generate it
    const demoTarget = path.join(ws, 'Demo', 'demo-room.ply');
    if (fs.existsSync(DEMO)) {
        await fsp.copyFile(DEMO, demoTarget);
    } else {
        await new Promise((resolve, reject) => {
            const p = spawn(process.execPath, [path.join(repo, 'scripts', 'make-test-splat.mjs'), demoTarget], { cwd: repo, stdio: 'ignore' });
            p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`make-test-splat exit ${c}`))));
        });
    }
    const port = await freePort();
    server = spawn(process.execPath, [path.join(repo, 'server', 'index.mjs')], { cwd: repo, env: { ...process.env, API_PORT: String(port), SPLAT_WORKSPACE: ws }, stdio: ['ignore', 'ignore', 'pipe'] });
    server.stderr.on('data', () => { /* quiet */ });
    await waitHealth(port);
    const base = `http://127.0.0.1:${port}`;

    const transport = new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...process.env, SPLAT_API_PORT: String(port) } });
    client = new Client({ name: 'mcp-e2e', version: '1.0.0' });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    const call = (name, args) => client.callTool({ name, arguments: args });

    console.log('Splat Studio MCP e2e\n');

    await check('catalog registers the full 28-tool set + resources', async () => {
        const want = ['workspace', 'projects', 'files', 'import_file', 'inspect', 'get_summary', 'jobs', 'convert', 'build_lod', 'render_image', 'generate_collision', 'trim_region',
            'camera', 'viewport_screenshot', 'viewport_click', 'load_into_viewport', 'set_view_option', 'select_item', 'get_editor_state', 'measure', 'set_origin', 'set_region', 'render_pose', 'set_collision_gizmo', 'panel', 'layout', 'history', 'suggest_lod_settings'];
        const missing = want.filter((n) => !tools.includes(n));
        assert(missing.length === 0, `missing tools: ${missing.join(',')}`);
        const res = (await client.listResources()).resources.map((r) => r.uri);
        assert(res.includes('splat-studio://projects') && res.includes('splat-studio://jobs'), `resources: ${res.join(',')}`);
    });

    await check('tools carry behaviour annotations (files destructive, inspect read-only)', async () => {
        const all = (await client.listTools()).tools;
        const byName = Object.fromEntries(all.map((t) => [t.name, t.annotations ?? {}]));
        assert(byName.files.destructiveHint === true, `files: ${JSON.stringify(byName.files)}`);
        assert(byName.inspect.readOnlyHint === true, `inspect: ${JSON.stringify(byName.inspect)}`);
        assert(byName.convert.destructiveHint === false, `convert: ${JSON.stringify(byName.convert)}`);
    });

    await check('inspect health + projects list', async () => {
        assert(data(await call('inspect', { target: 'health' })).ok === true, 'health not ok');
        assert(data(await call('projects', { action: 'list' })).projects?.includes('Demo'), 'Demo project missing');
    });

    await check('workspace get + live switch + restore', async () => {
        const g = data(await call('workspace', { action: 'get' }));
        assert(g.path && Array.isArray(g.projects), `get: ${JSON.stringify(g)}`);
        const bad = await call('workspace', { action: 'set', path: `${g.path}__nope__` });
        assert(bad.isError && data(bad).error === 'not-found', `bad path: ${text(bad)}`);
        const s = data(await call('workspace', { action: 'set', path: `${g.path}/mcp_ws_test`, create: true }));
        assert(s.path && s.projects.length === 0, `set+create: ${JSON.stringify(s)}`);
        const back = data(await call('workspace', { action: 'set', path: g.path }));
        assert(back.projects.includes('Demo'), `restore: ${JSON.stringify(back)}`);
    });

    await check('inspect stats returns count + extents', async () => {
        const s = data(await call('inspect', { target: 'stats', project: 'Demo', input: 'demo-room.ply' }));
        assert(s.count > 0 && Array.isArray(s.extents), `stats: ${JSON.stringify(s)}`);
    });

    await check('convert -> job -> wait -> done', async () => {
        const j = data(await call('convert', { project: 'Demo', input: 'demo-room.ply', format: 'ply' }));
        assert(j.jobId, 'no jobId');
        const w = data(await call('jobs', { action: 'wait', id: j.jobId, timeout_ms: 60000 }));
        assert(w.status === 'done' && w.outputs?.length, `job: ${JSON.stringify(w).slice(0, 160)}`);
    });

    await check('trim_region -> job -> done with a .ply output', async () => {
        const j = data(await call('trim_region', { project: 'Demo', input: 'demo-room.ply', mode: 'remove', sphere: [0, 0, 0, 0.1] }));
        assert(j.jobId, `no jobId: ${JSON.stringify(j)}`);
        const w = data(await call('jobs', { action: 'wait', id: j.jobId, timeout_ms: 60000 }));
        assert(w.status === 'done' && w.outputs?.some((o) => /\.ply$/i.test(o)), `trim job: ${JSON.stringify(w).slice(0, 160)}`);
    });

    await check('get_summary -> job -> stats table in the log', async () => {
        const j = data(await call('get_summary', { project: 'Demo', input: 'demo-room.ply' }));
        assert(j.jobId, `no jobId: ${JSON.stringify(j)}`);
        const w = data(await call('jobs', { action: 'wait', id: j.jobId, timeout_ms: 60000 }));
        assert(w.status === 'done', `summary job: ${JSON.stringify(w).slice(0, 160)}`);
        const full = data(await call('jobs', { action: 'get', id: j.jobId }));
        assert(/gaussians:\s*\d+/.test(full.log || ''), 'no stats in job log');
    });

    await check('build_lod (decimate, CPU) -> lod-meta.json output', async () => {
        const j = data(await call('build_lod', { project: 'Demo', input: 'demo-room.ply', mode: 'decimate', device: 'cpu', lodLevels: 2, lodKeepPercent: 50 }));
        assert(j.jobId, `no jobId: ${JSON.stringify(j)}`);
        const w = data(await call('jobs', { action: 'wait', id: j.jobId, timeout_ms: 120000 }));
        assert(w.status === 'done' && w.outputs?.some((o) => /lod-meta\.json$/.test(o)), `lod job: ${JSON.stringify(w).slice(0, 160)}`);
    });

    await check('render_image equirect rejects a non-2:1 resolution as bad-input', async () => {
        const r = await call('render_image', { project: 'Demo', input: 'demo-room.ply', image: { projection: 'equirect', resolution: '1000x1000' } });
        assert(r.isError && data(r).error === 'bad-input', `expected bad-input: ${text(r)}`);
        const dof = await call('render_image', { project: 'Demo', input: 'demo-room.ply', image: { projection: 'equirect', fStop: 2.8 } });
        assert(dof.isError && data(dof).error === 'bad-input', `equirect+fStop should be bad-input: ${text(dof)}`);
    });

    await check('files resource template lists a project\'s assets', async () => {
        const res = await client.readResource({ uri: 'splat-studio://files/Demo' });
        const body = JSON.parse(res.contents[0].text);
        assert(body.files?.some((f) => f.name === 'demo-room.ply'), `resource: ${JSON.stringify(body).slice(0, 160)}`);
    });

    await check('import_file with a missing source returns not-found', async () => {
        const r = await call('import_file', { project: 'Demo', source_path: path.join(os.tmpdir(), 'nope-does-not-exist.ply') });
        assert(r.isError && data(r).error === 'not-found', `expected not-found: ${text(r)}`);
    });

    await check('suggest_lod_settings proposes decimate settings', async () => {
        const s = data(await call('suggest_lod_settings', { project: 'Demo', input: 'demo-room.ply' }));
        assert(s.suggestion?.mode === 'decimate' && s.suggestion.lodLevels >= 1, `suggest: ${JSON.stringify(s)}`);
    });

    // no LOD is baked in this suite (slow), so only the missing-recipe path is covered
    await check('inspect lod_recipe on a missing bundle returns not-found', async () => {
        const r = await call('inspect', { target: 'lod_recipe', project: 'Demo', input: 'nope-lod/lod-meta.json' });
        assert(r.isError && data(r).error === 'not-found', `expected not-found: ${text(r)}`);
    });

    await check('generate_collision preflight refuses a fine-voxel whole-splat run (override bypasses)', async () => {
        // 28k gaussians at 0.001 m -> load ~71M >> the 16.7M cap -> danger -> refused
        const r = data(await call('generate_collision', { project: 'Demo', input: 'demo-room.ply', voxelSize: 0.001 }));
        assert(r.refused === true && r.preflight?.riskLevel === 'danger', `expected a refusal: ${JSON.stringify(r).slice(0, 180)}`);
        const o = data(await call('generate_collision', { project: 'Demo', input: 'demo-room.ply', voxelSize: 0.001, overridePreflight: true }));
        assert(o.jobId && !o.refused, `override should start a job: ${JSON.stringify(o).slice(0, 180)}`);
        await call('jobs', { action: 'cancel', id: o.jobId }); // don't leave a doomed GPU job running
    });

    await check('MCP prompts are registered', async () => {
        const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
        assert(['optimize_for_web', 'setup_collision', 'inspect_splat', 'clean_up_scan', 'scale_to_real_world'].every((n) => prompts.includes(n)), `prompts: ${prompts.join(',')}`);
    });

    await check('headless error shapes: not-found + bad-input', async () => {
        const nf = await call('files', { action: 'list', project: 'NopeProject' });
        assert(nf.isError && data(nf).error === 'not-found', `expected not-found: ${text(nf)}`);
        const bi = await call('trim_region', { project: 'Demo', input: 'demo-room.ply' });
        assert(bi.isError && data(bi).error === 'bad-input', `expected bad-input: ${text(bi)}`);
    });

    await check('editor tool returns no-editor when unconnected', async () => {
        const r = await call('panel', { action: 'open', id: 'panel-edit' });
        assert(r.isError && data(r).error === 'no-editor', `expected no-editor: ${text(r)}`);
    });

    await check('inspect editor_status probes without consent (disconnected)', async () => {
        const s = data(await call('inspect', { target: 'editor_status' }));
        assert(s.connected === false && s.controlEnabled === false, `status: ${JSON.stringify(s)}`);
    });

    ed = mockEditor(port);
    await sleep(400);

    await check('editor tool returns control-disabled when consent off', async () => {
        const r = await call('get_editor_state', {});
        assert(r.isError && data(r).error === 'control-disabled', `expected control-disabled: ${text(r)}`);
    });

    await check('consent on: editor commands forward + ok:false passes through', async () => {
        await fetch(`${base}/api/editor/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
        assert(data(await call('panel', { action: 'open', id: 'panel-edit' })).name === 'panel', 'panel did not forward');
        const sel = await call('select_item', { id: 'nope' });
        assert(sel.isError && data(sel).error === 'not-found', `expected not-found passthrough: ${text(sel)}`);
    });

    await check('viewport_screenshot returns an image content block', async () => {
        const r = await call('viewport_screenshot', {});
        assert(r.content?.some((c) => c.type === 'image' && c.mimeType === 'image/png'), `no image block: ${JSON.stringify(r.content)}`);
    });

    await check('editor_status reflects the connected editor + consent, and history forwards', async () => {
        const s = data(await call('inspect', { target: 'editor_status' }));
        assert(s.connected === true && s.controlEnabled === true, `status: ${JSON.stringify(s)}`);
        const h = data(await call('history', { action: 'get' }));
        assert(h.name === 'history' && h.params?.action === 'get', `forward: ${JSON.stringify(h)}`);
    });

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
} catch (e) {
    console.error('mcp-e2e crashed:', e?.stack || e);
    process.exitCode = 1;
} finally {
    try { await client?.close(); } catch { /* */ }
    try { ed?.close(); } catch { /* */ }
    try { server?.kill(); } catch { /* */ }
    await sleep(200);
}
