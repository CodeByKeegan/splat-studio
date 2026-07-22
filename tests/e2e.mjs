// End-to-end regression suite for Splat Studio.
//
// Black-box: boots the real server on a throwaway workspace seeded with a test
// splat + the sample generator, then exercises every server-side function over
// the HTTP API and asserts on outputs. This is the suite the autonomous
// dependency-update routine runs after bumping splat-transform / playcanvas.
//
//   node tests/e2e.mjs            run everything
//   SKIP_GPU=1 node tests/e2e.mjs skip GPU-only checks (collision, voxels)
//
// Exit code 0 = all passed, 1 = at least one failure.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_GPU = process.env.SKIP_GPU === '1';

// ---------- tiny test runner ----------
let passed = 0;
const failures = [];
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };
const fail = (name, err) => { failures.push(name); console.error(`  ✗ ${name}\n      ${err}`); };
const check = async (name, fn) => {
    try { await fn(); ok(name); } catch (err) { fail(name, err?.message ?? err); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---------- helpers ----------
const freePort = () => new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

let BASE = '';
const api = async (method, route, body) => {
    const res = await fetch(`${BASE}${route}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
};

const PROJECT = 'test';
// run a job (convert/collision/summary) to completion; returns the finished job
const runJob = async (route, payload, timeoutMs = 120000) => {
    const { status, json } = await api('POST', route, { ...payload, project: PROJECT });
    if (status !== 200 || !json.jobId) throw new Error(`${route} -> ${status} ${JSON.stringify(json)}`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const { json: job } = await api('GET', `/api/jobs/${json.jobId}`);
        if (job.status !== 'running') return job;
        if (Date.now() > deadline) throw new Error(`job timed out: ${job.title}`);
        await new Promise((r) => setTimeout(r, 300));
    }
};

const waitHealth = (port) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 30000;
    const tick = () => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
            res.resume();
            res.statusCode === 200 ? resolve() : retry();
        });
        req.on('error', retry);
        req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => (Date.now() > deadline ? reject(new Error('server never came up')) : setTimeout(tick, 250));
    tick();
});

// ---------- main ----------
let server;
const ws = await fsp.mkdtemp(path.join(os.tmpdir(), 'splat-studio-e2e-'));
try {
    // seed a test project: synthetic splat + the sample generator
    const projectDir = path.join(ws, PROJECT);
    await fsp.mkdir(projectDir, { recursive: true });
    // make-test-splat writes to <root>/workspace/demo-room.ply
    await new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [path.join(root, 'scripts', 'make-test-splat.mjs')], { cwd: root });
        p.on('error', reject);
        p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`make-test-splat exit ${c}`))));
    });
    await fsp.copyFile(path.join(root, 'workspace', 'demo-room.ply'), path.join(projectDir, 'demo-room.ply'));
    await fsp.copyFile(path.join(root, 'examples', 'gen-grid.mjs'), path.join(projectDir, 'gen-grid.mjs'));

    const port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [path.join(root, 'server', 'index.mjs')], {
        cwd: root,
        env: { ...process.env, API_PORT: String(port), SPLAT_WORKSPACE: ws },
        stdio: ['ignore', 'ignore', 'inherit']
    });
    await waitHealth(port);
    console.log(`\nSplat Studio e2e — server on ${BASE}, workspace ${ws}${SKIP_GPU ? ' (SKIP_GPU)' : ''}\n`);

    await check('health reports the CLI is present', async () => {
        const { json } = await api('GET', '/api/health');
        assert(json.ok === true && json.cli === true, `health: ${JSON.stringify(json)}`);
    });

    await check('versions endpoint reports app + splat-transform', async () => {
        const { json } = await api('GET', '/api/versions');
        assert(/^\d+\.\d+\.\d+/.test(json.app || ''), `app version: ${JSON.stringify(json)}`);
        assert(/^\d+\.\d+\.\d+/.test(json.splatTransform || ''), `splat-transform version: ${JSON.stringify(json)}`);
    });

    await check('lists the seeded project', async () => {
        const { json } = await api('GET', '/api/projects');
        assert(json.projects.includes(PROJECT), `projects: ${JSON.stringify(json.projects)}`);
    });

    await check('workspace: get, live-switch (create), validation, restore', async () => {
        const cur = await api('GET', '/api/workspace');
        assert(cur.json.path && cur.json.projects.includes(PROJECT), `get: ${JSON.stringify(cur.json)}`);
        const alt = await fsp.mkdtemp(path.join(os.tmpdir(), 'splat-studio-e2e-alt-'));
        await fsp.mkdir(path.join(alt, 'AltProject'));
        const sw = await api('POST', '/api/workspace', { path: alt });
        assert(sw.status === 200 && sw.json.projects.includes('AltProject') && !sw.json.projects.includes(PROJECT), `switch: ${JSON.stringify(sw.json)}`);
        const bad = await api('POST', '/api/workspace', { path: path.join(alt, 'nope') });
        assert(bad.status === 400, `missing folder should 400, got ${bad.status}`);
        const missing = await api('POST', '/api/workspace', {});
        assert(missing.status === 400, `missing path should 400, got ${missing.status}`);
        const made = path.join(alt, 'made');
        const cr = await api('POST', '/api/workspace', { path: made, create: true });
        assert(cr.status === 200 && cr.json.path === made, `create: ${JSON.stringify(cr.json)}`);
        const back = await api('POST', '/api/workspace', { path: cur.json.path });
        assert(back.status === 200 && back.json.projects.includes(PROJECT), `restore: ${JSON.stringify(back.json)}`);
        await fsp.rm(alt, { recursive: true, force: true });
    });

    await check('per-workspace layout round-trips (empty → save → read)', async () => {
        const fresh = await api('GET', '/api/layout');
        assert(fresh.status === 200 && JSON.stringify(fresh.json) === '{}', `fresh: ${fresh.status} ${JSON.stringify(fresh.json)}`);
        const save = await api('POST', '/api/layout', { __v: 1, dockview: { grid: 'x' } });
        assert(save.status === 200 && save.json.ok, `save: ${save.status} ${JSON.stringify(save.json)}`);
        const read = await api('GET', '/api/layout');
        assert(read.json.__v === 1 && read.json.dockview?.grid === 'x', `read: ${JSON.stringify(read.json)}`);
        const bad = await api('POST', '/api/layout', [1, 2, 3]);
        assert(bad.status === 400, `array body should 400, got ${bad.status}`);
        const projects = await api('GET', '/api/projects');
        assert(!projects.json.projects.includes('.splat-studio-layout.json'), 'layout dotfile must not appear as a project');
    });

    await check('classifies file kinds (splat + generator)', async () => {
        const { json } = await api('GET', `/api/files?project=${PROJECT}`);
        const kinds = Object.fromEntries(json.files.map((f) => [f.name, f.kind]));
        assert(kinds['demo-room.ply'] === 'splat', `demo-room.ply kind: ${kinds['demo-room.ply']}`);
        assert(kinds['gen-grid.mjs'] === 'generator', `gen-grid.mjs kind: ${kinds['gen-grid.mjs']}`);
    });

    // convert: format -> expected output filename
    const CONVERTS = [
        ['ply', 'demo-room.ply', { format: 'ply' }, 'demo-room-converted.ply'],
        ['compressed-ply', 'demo-room.ply', { format: 'compressed-ply' }, 'demo-room.compressed.ply'],
        ['spz', 'demo-room.ply', { format: 'spz' }, 'demo-room.spz'],
        ['glb', 'demo-room.ply', { format: 'glb' }, 'demo-room.glb'],
        ['csv', 'demo-room.ply', { format: 'csv' }, 'demo-room.csv'],
        ['html', 'demo-room.ply', { format: 'html' }, 'demo-room.html'],
        ['sog (GPU/CPU)', 'demo-room.ply', { format: 'sog', options: { device: SKIP_GPU ? 'cpu' : 'auto' } }, 'demo-room.sog'],
        ['sog-unbundled', 'demo-room.ply', { format: 'sog-unbundled', options: { device: SKIP_GPU ? 'cpu' : 'auto' } }, 'demo-room-sog/meta.json'],
        ['streamed LOD', 'demo-room.ply', { format: 'lod', options: { device: SKIP_GPU ? 'cpu' : 'auto', lodLevels: 2 } }, 'demo-room-lod/lod-meta.json']
    ];
    for (const [label, input, opts, expected] of CONVERTS) {
        await check(`convert -> ${label}`, async () => {
            const job = await runJob('/api/convert', { input, ...opts });
            assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
            assert(fs.existsSync(path.join(projectDir, ...expected.split('/'))), `missing output ${expected}`);
        });
    }

    // 3.1.0: lod-meta.json (our own streamed-SOG output) is now a valid INPUT too,
    // same --select-lod capability already offered for .lcc/.lcc2 input
    await check('--select-lod reads back a subset of a streamed-SOG (lod-meta.json) bundle', async () => {
        const job = await runJob('/api/convert', {
            input: 'demo-room-lod/lod-meta.json', format: 'ply',
            options: { lodSelect: '0' }
        });
        assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
        assert(/--select-lod 0\b/.test(job.command), `no --select-lod 0 in cmd: ${job.command}`);
    });

    // decimate LOD mode pre-decimates each level to a temp .ply then combines them
    // (splat-transform 3.0.0: --decimate must be a standalone final .ply action)
    await check('streamed LOD (decimate, 3 levels) bakes + cleans temps', async () => {
        const job = await runJob('/api/convert', {
            input: 'demo-room.ply', format: 'lod',
            options: { device: SKIP_GPU ? 'cpu' : 'auto', lodLevels: 3, lodKeepPercent: 50 }
        });
        assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
        const meta = JSON.parse(fs.readFileSync(path.join(projectDir, 'demo-room-lod', 'lod-meta.json'), 'utf8'));
        assert(meta.lodLevels === 3, `expected 3 LOD levels, got ${meta.lodLevels}`);
        assert(!fs.existsSync(path.join(projectDir, 'demo-room-lod-src')), 'temp decimate dir not cleaned up');
        assert(!job.command.includes('--scratch-dir'), `--scratch-dir without scratchDir option: ${job.command}`);
    });

    // build recipe persisted inside the bundle, before the job flips to 'done'
    await check('build-meta.json records the decimate recipe + per-level gaussians', async () => {
        const bmPath = path.join(projectDir, 'demo-room-lod', 'build-meta.json');
        assert(fs.existsSync(bmPath), 'no build-meta.json in the bundle');
        const bm = JSON.parse(fs.readFileSync(bmPath, 'utf8'));
        const meta = JSON.parse(fs.readFileSync(path.join(projectDir, 'demo-room-lod', 'lod-meta.json'), 'utf8'));
        assert(bm.version === 1, `version: ${bm.version}`);
        assert(bm.mode === 'decimate', `mode: ${bm.mode}`);
        assert(bm.input === 'demo-room.ply', `input: ${bm.input}`);
        assert(!Number.isNaN(Date.parse(bm.createdAt)), `createdAt: ${bm.createdAt}`);
        const versions = (await api('GET', '/api/versions')).json;
        assert(bm.generator?.app === versions.app && bm.generator?.splatTransform === versions.splatTransform,
            `generator: ${JSON.stringify(bm.generator)}`);
        // level 0 = raw input at 100%; each level keeps 50% of the previous
        assert(Array.isArray(bm.levels) && bm.levels.length === 3, `levels: ${JSON.stringify(bm.levels)}`);
        bm.levels.forEach((l, i) => {
            assert(l.level === i && l.source === 'demo-room.ply' && !l.environment, `level ${i}: ${JSON.stringify(l)}`);
            assert(l.gaussians === meta.counts[i], `level ${i} gaussians ${l.gaussians} != lod-meta counts ${meta.counts[i]}`);
        });
        assert(JSON.stringify(bm.levels.map((l) => l.keepPercent)) === '[100,50,25]',
            `keepPercent chain: ${JSON.stringify(bm.levels.map((l) => l.keepPercent))}`);
        const s = bm.settings;
        assert(s.lodLevels === 3 && s.keepPercent === 50, `settings: ${JSON.stringify(s)}`);
        assert(s.iterations === 10 && s.chunkCount === 512 && s.chunkExtent === 16 && s.filterNaN === false,
            `settings defaults: ${JSON.stringify(s)}`);
        assert(s.device === (SKIP_GPU ? 'cpu' : 'auto') && s.maxWorkers === undefined,
            `settings device/workers: ${JSON.stringify(s)}`);
    });

    // cheap count parsed from lod-meta.json itself — must mirror what the CLI wrote
    await check('files listing: lod entry carries gaussians + per-level lodCounts', async () => {
        const meta = JSON.parse(fs.readFileSync(path.join(projectDir, 'demo-room-lod', 'lod-meta.json'), 'utf8'));
        const { json } = await api('GET', `/api/files?project=${PROJECT}`);
        const lod = json.files.find((f) => f.name === 'demo-room-lod/lod-meta.json');
        assert(lod, 'no lod-meta.json entry in /api/files');
        assert(Number.isFinite(lod.gaussians) && lod.gaussians > 0, `gaussians: ${lod.gaussians}`);
        assert(lod.gaussians === meta.count, `gaussians ${lod.gaussians} != meta.count ${meta.count}`);
        assert(Array.isArray(lod.lodCounts) && lod.lodCounts.length === meta.lodLevels,
            `lodCounts ${JSON.stringify(lod.lodCounts)} (expected ${meta.lodLevels} levels)`);
        assert(lod.lodCounts.every((c) => Number.isFinite(c) && c > 0), `bad level count: ${JSON.stringify(lod.lodCounts)}`);
        assert(lod.lodCounts.reduce((a, b) => a + b, 0) === lod.gaussians,
            `lodCounts ${JSON.stringify(lod.lodCounts)} don't sum to ${lod.gaussians}`);
    });

    // 3.0.0: --decimate writes a PLY only — decimating to a non-PLY format is rejected up front
    await check('decimate to a non-PLY format is rejected', async () => {
        const { status, json } = await api('POST', '/api/convert', { project: PROJECT, input: 'demo-room.ply', format: 'sog', options: { decimate: '50%', device: SKIP_GPU ? 'cpu' : 'auto' } });
        assert(status === 400 && /PLY/i.test(json.error || ''), `expected 400 PLY error, got ${status} ${JSON.stringify(json)}`);
    });

    // --scratch-dir: decimation spill location — emitted only when decimate is active
    await check('decimate + scratchDir emits --scratch-dir', async () => {
        const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'splat-studio-scratch-'));
        try {
            const job = await runJob('/api/convert', {
                input: 'demo-room.ply', format: 'ply',
                options: { decimate: '50%', device: SKIP_GPU ? 'cpu' : 'auto', scratchDir: scratch }
            });
            assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
            assert(job.command.includes(`--scratch-dir ${scratch}`), `no --scratch-dir in cmd: ${job.command}`);
        } finally {
            await fsp.rm(scratch, { recursive: true, force: true });
        }
    });

    await check('scratchDir without decimate is silently ignored (never emitted)', async () => {
        // bogus value on purpose: without decimate it must not even be validated
        const job = await runJob('/api/convert', {
            input: 'demo-room.ply', format: 'csv',
            options: { scratchDir: 'not-an-absolute-path' }
        });
        assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
        assert(!job.command.includes('--scratch-dir'), `--scratch-dir leaked into cmd: ${job.command}`);
    });

    await check('decimate + invalid scratchDir is rejected up front', async () => {
        const rel = await api('POST', '/api/convert', {
            project: PROJECT, input: 'demo-room.ply', format: 'ply',
            options: { decimate: '50%', scratchDir: 'relative/spill' }
        });
        assert(rel.status === 400 && /absolute/i.test(rel.json.error || ''), `relative path: ${rel.status} ${JSON.stringify(rel.json)}`);
        const missing = await api('POST', '/api/convert', {
            project: PROJECT, input: 'demo-room.ply', format: 'ply',
            options: { decimate: '50%', scratchDir: path.join(os.tmpdir(), 'splat-studio-scratch-does-not-exist') }
        });
        assert(missing.status === 400 && /not found|existing directory/i.test(missing.json.error || ''), `missing dir: ${missing.status} ${JSON.stringify(missing.json)}`);
    });

    await check('LOD decimate mode: --scratch-dir on each pre-command, not the combine', async () => {
        const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'splat-studio-scratch-'));
        try {
            const job = await runJob('/api/convert', {
                input: 'demo-room.ply', format: 'lod',
                options: { device: SKIP_GPU ? 'cpu' : 'auto', lodLevels: 3, lodKeepPercent: 50, scratchDir: scratch }
            });
            assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
            const lines = job.command.split('\n');
            assert(lines.length === 3, `expected 2 pre-commands + combine, got ${lines.length}: ${job.command}`);
            assert(lines.slice(0, 2).every((l) => l.includes(`--scratch-dir ${scratch}`)), `pre-commands missing --scratch-dir: ${job.command}`);
            assert(!lines[2].includes('--scratch-dir'), `combine step must not carry --scratch-dir: ${lines[2]}`);
        } finally {
            await fsp.rm(scratch, { recursive: true, force: true });
        }
    });

    await check('summary (--stats) prints a stats table, writes nothing', async () => {
        const job = await runJob('/api/summary', { input: 'demo-room.ply' });
        assert(job.status === 'done', `job ${job.status}`);
        assert(/^gaussians:\s*\d+/m.test(job.log) && /\|\s*Column\s*\|/.test(job.log), 'no summary table in log');
        assert(job.outputs.length === 0, `summary wrote files: ${job.outputs}`);
    });

    await check('generator (.mjs) input + params (-p) synthesizes a splat', async () => {
        const job = await runJob('/api/convert', { input: 'gen-grid.mjs', format: 'ply', options: { params: 'width=10,height=10,scale=3' } });
        assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
        assert(fs.existsSync(path.join(projectDir, 'gen-grid.ply')), 'no generator output');
        const sum = await runJob('/api/summary', { input: 'gen-grid.ply' });
        const rc = (sum.log.match(/^gaussians:\s*(\d+)/m) || [])[1];
        assert(Number(rc) === 100, `expected 100 gaussians, got ${rc}`);
    });

    await check('generator-params exposes the slider schema (if built)', async () => {
        const { status, json } = await api('GET', `/api/generator-params?project=${PROJECT}&input=gen-grid.mjs`);
        if (status === 404) { console.log('      (route not on this build — skipped)'); return; }
        assert(status === 200, `status ${status}`);
        // null is valid (generator without a schema); an array must name its params
        assert(json.params === null || (Array.isArray(json.params) && json.params.some((p) => p.name === 'width')),
            `schema: ${JSON.stringify(json.params)}`);
    });

    await check('rejects path traversal in the convert input', async () => {
        const { status } = await api('POST', '/api/convert', { project: PROJECT, input: '../../etc/passwd', format: 'ply' });
        assert(status === 400, `expected 400, got ${status}`);
    });

    // ----- output options & device -----
    await check('--verbose/--memory diagnostics flag', async () => {
        const job = await runJob('/api/convert', { input: 'demo-room.ply', format: 'ply', options: { verbose: true } });
        assert(job.status === 'done' && /--verbose/.test(job.command) && /--memory\b/.test(job.command), `cmd: ${job.command}`);
    });

    await check('HTML unbundled (--unbundled) + viewer-settings (--viewer-settings)', async () => {
        await fsp.writeFile(path.join(projectDir, 'settings.json'), '{}');
        const job = await runJob('/api/convert', { input: 'demo-room.ply', format: 'html', options: { unbundled: true, viewerSettings: 'settings.json' } });
        assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
        assert(/--unbundled\b/.test(job.command) && /--viewer-settings settings\.json/.test(job.command), `cmd: ${job.command}`);
    });

    await check('SOG encoder workers (--max-workers)', async () => {
        const job = await runJob('/api/convert', { input: 'demo-room.ply', format: 'html', options: { maxWorkers: 2 } });
        assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
        assert(/--max-workers 2\b/.test(job.command), `cmd: ${job.command}`);
    });

    await check('streamed LOD combine + environment level (-l -1)', async () => {
        await fsp.copyFile(path.join(projectDir, 'demo-room.ply'), path.join(projectDir, 'env-shell.ply'));
        await fsp.copyFile(path.join(projectDir, 'demo-room.ply'), path.join(projectDir, 'detail-1.ply'));
        const job = await runJob('/api/convert', {
            input: 'demo-room.ply',
            format: 'lod',
            options: { device: SKIP_GPU ? 'cpu' : 'auto', lodFiles: ['env-shell.ply', 'detail-1.ply'], lodEnvFlags: [true, false] }
        });
        assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
        // input is LOD 0; the env file is tagged -1; the detail file gets the next positive level (1)
        assert(/env-shell\.ply -l -1\b/.test(job.command), `no env -l -1 in cmd: ${job.command}`);
        assert(/ -l 0\b/.test(job.command) && /detail-1\.ply -l 1\b/.test(job.command), `levels not contiguous: ${job.command}`);
        assert(fs.existsSync(path.join(projectDir, 'demo-room-lod', 'lod-meta.json')), 'no lod-meta.json');
    });

    await check('build-meta.json records the combine recipe (env level last + flagged)', async () => {
        const bm = JSON.parse(fs.readFileSync(path.join(projectDir, 'demo-room-lod', 'build-meta.json'), 'utf8'));
        const meta = JSON.parse(fs.readFileSync(path.join(projectDir, 'demo-room-lod', 'lod-meta.json'), 'utf8'));
        assert(bm.version === 1 && bm.mode === 'combine', `header: v${bm.version} ${bm.mode}`);
        assert(bm.input === 'demo-room.ply', `input: ${bm.input}`);
        assert(!Number.isNaN(Date.parse(bm.createdAt)), `createdAt: ${bm.createdAt}`);
        const rows = bm.levels.map((l) => `${l.level}:${l.source}`);
        assert(JSON.stringify(rows) === JSON.stringify(['0:demo-room.ply', '1:detail-1.ply', '-1:env-shell.ply']),
            `levels: ${JSON.stringify(bm.levels)}`);
        assert(bm.levels[2].environment === true && bm.levels.slice(0, 2).every((l) => !l.environment),
            `env flags: ${JSON.stringify(bm.levels)}`);
        // structural levels count from lod-meta counts; the env shell from env/meta.json
        for (const l of bm.levels.slice(0, 2)) {
            assert(l.gaussians === meta.counts[l.level], `level ${l.level} gaussians ${l.gaussians} != lod-meta counts ${meta.counts[l.level]}`);
        }
        const envMeta = JSON.parse(fs.readFileSync(path.join(projectDir, 'demo-room-lod', 'env', 'meta.json'), 'utf8'));
        assert(bm.levels[2].gaussians === envMeta.count, `env gaussians ${bm.levels[2].gaussians} != env/meta.json count ${envMeta.count}`);
        // the files walk stops at the bundle entry point — the recipe never surfaces
        const files = await api('GET', `/api/files?project=${PROJECT}`);
        assert(!files.json.files.some((f) => f.name.endsWith('build-meta.json')), 'build-meta.json leaked into /api/files');
    });

    await check('rejects an all-environment combine bake', async () => {
        const { status } = await api('POST', '/api/convert', {
            project: PROJECT, input: 'demo-room.ply', format: 'lod',
            options: { lodFiles: ['env-shell.ply'], lodEnvFlags: [true] }
        });
        assert(status === 400, `expected 400, got ${status}`);
    });

    await check('lists GPU adapters (--list-gpus)', async () => {
        const { json } = await api('GET', '/api/gpus');
        assert(Array.isArray(json.gpus), `gpus: ${JSON.stringify(json)}`);
    });

    await check('stats endpoint returns gaussian count + extents', async () => {
        const { status, json } = await api('GET', `/api/stats?project=${PROJECT}&input=demo-room.ply`);
        assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
        assert(Number.isFinite(json.count) && json.count > 1000, `count ${json.count}`);
        assert(Array.isArray(json.extents) && json.extents.length === 3 && json.extents.every((e) => Number.isFinite(e) && e > 0),
            `extents ${JSON.stringify(json.extents)}`);
        const bad = await api('GET', `/api/stats?project=${PROJECT}&input=does-not-exist.ply`);
        assert(bad.status === 400, `missing file should 400, got ${bad.status}`);
    });

    // cheap header-read counts on /api/files must agree with the CLI --stats scan
    await check('files listing: .ply gaussians matches --stats exactly', async () => {
        const stats = await api('GET', `/api/stats?project=${PROJECT}&input=demo-room.ply`);
        assert(stats.status === 200 && Number.isFinite(stats.json.count), `stats: ${JSON.stringify(stats.json)}`);
        const { json } = await api('GET', `/api/files?project=${PROJECT}`);
        const ply = json.files.find((f) => f.name === 'demo-room.ply');
        assert(ply && Number.isFinite(ply.gaussians) && ply.gaussians > 0, `gaussians: ${ply?.gaussians}`);
        assert(ply.gaussians === stats.json.count, `cheap count ${ply.gaussians} != stats count ${stats.json.count}`);
    });

    await check('files listing: derived .sog/meta.json/.compressed.ply/.spz gaussians match the source ply', async () => {
        const { json } = await api('GET', `/api/files?project=${PROJECT}`);
        const byName = Object.fromEntries(json.files.map((f) => [f.name, f]));
        const src = byName['demo-room.ply']?.gaussians;
        assert(Number.isFinite(src) && src > 0, `source gaussians: ${src}`);
        for (const name of ['demo-room.sog', 'demo-room-sog/meta.json', 'demo-room.compressed.ply', 'demo-room.spz']) {
            assert(byName[name], `no ${name} entry in /api/files`);
            assert(byName[name].gaussians === src, `${name} gaussians ${byName[name]?.gaussians} != ${src}`);
        }
    });

    // a hostile .sog whose meta.json inflates far past its compressed size must be
    // ignored (decompressed-size cap), never parsed or ballooned in memory
    await check('files listing: crafted .sog decompression bomb yields no count, listing survives', async () => {
        const zlib = await import('node:zlib');
        const big = Buffer.concat([Buffer.from('{"count":42,"pad":"'), Buffer.alloc(64 * 1024 * 1024, 0x61), Buffer.from('"}')]);
        const payload = zlib.deflateRawSync(big);
        const name = Buffer.from('meta.json');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt16LE(name.length, 26);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(8, 10);
        cd.writeUInt32LE(payload.length, 20);
        cd.writeUInt32LE(big.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt32LE(0, 42); // local header at offset 0
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(1, 8);
        eocd.writeUInt16LE(1, 10);
        eocd.writeUInt32LE(46 + name.length, 12);
        eocd.writeUInt32LE(30 + name.length + payload.length, 16);
        await fsp.writeFile(path.join(ws, PROJECT, 'bomb.sog'), Buffer.concat([local, name, payload, cd, name, eocd]));
        const { status, json } = await api('GET', `/api/files?project=${PROJECT}`);
        assert(status === 200, `status ${status}`);
        const bomb = json.files.find((f) => f.name === 'bomb.sog');
        assert(bomb, 'bomb.sog not listed');
        assert(bomb.gaussians === undefined, `bomb count surfaced: ${bomb.gaussians}`);
        const del = await api('DELETE', `/api/files/bomb.sog?project=${PROJECT}`);
        assert(del.status === 200, `cleanup delete -> ${del.status}`);
    });

    await check('trim (carve out) removes gaussians inside a box; remove+keep partitions', async () => {
        const keptOf = (log) => {
            const m = log.match(/kept ([\d,]+) of ([\d,]+)/);
            assert(m, `no kept/total in trim log: ${log.slice(-200)}`);
            return [Number(m[1].replace(/,/g, '')), Number(m[2].replace(/,/g, ''))];
        };
        const rm = await runJob('/api/trim', { input: 'demo-room.ply', options: { mode: 'remove', box: ['0', '', '', '', '', ''] } });
        assert(rm.status === 'done', `remove job ${rm.status}: ${(rm.log || '').slice(-200)}`);
        assert(fs.existsSync(path.join(projectDir, 'demo-room-trimmed.ply')), 'no trimmed output');
        const [k1, total] = keptOf(rm.log);
        assert(total > 0 && k1 > 0 && k1 < total, `expected 0 < kept(${k1}) < total(${total})`);
        const keep = await runJob('/api/trim', { input: 'demo-room.ply', options: { mode: 'keep', box: ['0', '', '', '', '', ''] } });
        assert(keep.status === 'done', `keep job ${keep.status}`);
        const [k2] = keptOf(keep.log);
        assert(k1 + k2 === total, `remove + keep must partition every gaussian: ${k1} + ${k2} != ${total}`);
        const bad = await api('POST', '/api/trim', { project: PROJECT, input: 'demo-room.ply', options: { mode: 'remove' } });
        assert(bad.status === 400, `trim with no region should 400, got ${bad.status}`);
        const notSplat = await api('POST', '/api/trim', { project: PROJECT, input: 'gen-grid.mjs', options: { mode: 'remove', box: ['0', '', '', '', '', ''] } });
        assert(notSplat.status === 400, `trim of a non-splat (.mjs) should 400, got ${notSplat.status}`);
    });

    // compressed formats route through a CLI decompress before trimming. .compressed.ply
    // is the trap case — its records are packed, not float x/y/z, so it must NOT take the
    // direct-PLY path despite the .ply suffix.
    for (const [src, made] of [['demo-room.sog', 'sog convert test'], ['demo-room.compressed.ply', 'compressed-ply convert test']]) {
        await check(`non-PLY trim (${src}) decompresses to PLY then trims`, async () => {
            assert(fs.existsSync(path.join(projectDir, src)), `precondition: ${src} (from the ${made})`);
            const job = await runJob('/api/trim', { input: src, options: { mode: 'remove', box: ['0', '', '', '', '', ''] } });
            assert(job.status === 'done', `${src} trim ${job.status}: ${(job.log || '').slice(-200)}`);
            assert(/for trimming/i.test(job.log || ''), `expected a decompress-to-PLY step in the log: ${(job.log || '').slice(-200)}`);
            const m = (job.log || '').match(/kept ([\d,]+) of ([\d,]+)/);
            assert(m, `no kept/total in ${src} trim log: ${(job.log || '').slice(-200)}`);
            const kept = Number(m[1].replace(/,/g, '')), total = Number(m[2].replace(/,/g, ''));
            assert(total > 0 && kept > 0 && kept < total, `${src} trim expected 0 < kept(${kept}) < total(${total})`);
        });
    }

    await check('trim of a truncated binary PLY errors clearly (no silent corrupt output)', async () => {
        // header declares 3 vertices (x,y,z float32 = 12 bytes each) but the body is short
        const header = 'ply\nformat binary_little_endian 1.0\nelement vertex 3\n'
            + 'property float x\nproperty float y\nproperty float z\nend_header\n';
        const body = Buffer.alloc(12); // one vertex worth — 2 short of the declared 3
        await fsp.writeFile(path.join(projectDir, 'truncated.ply'), Buffer.concat([Buffer.from(header, 'ascii'), body]));
        const job = await runJob('/api/trim', { input: 'truncated.ply', options: { mode: 'remove', box: ['0', '', '', '', '', ''] } });
        assert(job.status === 'error', `truncated PLY should error, got ${job.status}: ${(job.log || '').slice(-200)}`);
        assert(/truncated/i.test(job.log || ''), `error should mention "truncated": ${(job.log || '').slice(-200)}`);
        assert(!fs.existsSync(path.join(projectDir, 'truncated-trimmed.ply')), 'must not leave a corrupt trimmed output');
    });

    await check('location groups round-trip (project-scoped) + dotfile stays hidden', async () => {
        const empty = await api('GET', `/api/groups?project=${PROJECT}`);
        assert(empty.status === 200 && Array.isArray(empty.json.members), `empty: ${JSON.stringify(empty.json)}`);
        const save = await api('POST', `/api/groups?project=${PROJECT}`, { members: ['demo-room.ply'], proxy: 'demo-room.ply' });
        assert(save.status === 200 && save.json.ok, `save: ${save.status} ${JSON.stringify(save.json)}`);
        const read = await api('GET', `/api/groups?project=${PROJECT}`);
        assert(read.json.members[0] === 'demo-room.ply' && read.json.proxy === 'demo-room.ply', `read: ${JSON.stringify(read.json)}`);
        const bad = await api('POST', `/api/groups?project=${PROJECT}`, { members: ['../../etc/passwd'] });
        assert(bad.status === 400, `traversal member should 400, got ${bad.status}`);
        const files = await api('GET', `/api/files?project=${PROJECT}`);
        assert(!files.json.files.some((f) => f.name.includes('location-group')), 'group dotfile must not be surfaced');
    });

    await check('convert: an identical transform lands consistently across files (group fan-out invariant)', async () => {
        // two members = copies of the demo splat; the SAME -t must shift both identically
        await fsp.copyFile(path.join(projectDir, 'demo-room.ply'), path.join(projectDir, 'grp-a.ply'));
        await fsp.copyFile(path.join(projectDir, 'demo-room.ply'), path.join(projectDir, 'grp-b.ply'));
        const xMin = (log) => {
            const m = log.match(/\|\s*x\s*\|\s*(-?[\d.eE+]+)/);
            assert(m, `no x row in summary: ${log.slice(0, 300)}`);
            return Number(m[1]);
        };
        const src = xMin((await runJob('/api/summary', { input: 'grp-a.ply' })).log);
        const ja = await runJob('/api/convert', { input: 'grp-a.ply', format: 'ply', options: { translate: [5, 0, 0] } });
        const jb = await runJob('/api/convert', { input: 'grp-b.ply', format: 'ply', options: { translate: [5, 0, 0] } });
        assert(ja.status === 'done' && jb.status === 'done', `jobs: ${ja.status}/${jb.status}`);
        const xa = xMin((await runJob('/api/summary', { input: 'grp-a-converted.ply' })).log);
        const xb = xMin((await runJob('/api/summary', { input: 'grp-b-converted.ply' })).log);
        // the CLI's -t negates world x; assert both moved by the SAME ~±5 delta, not a hardcoded sign
        assert(Math.abs(xa - xb) < 1e-3, `members diverged: x-min ${xa} vs ${xb}`);
        assert(Math.abs(Math.abs(xa - src) - 5) < 0.5, `expected a ±5 shift, got ${(xa - src).toFixed(3)}`);
    });

    await check('rejects a bad WebP resolution', async () => {
        const { status } = await api('POST', '/api/convert', { project: PROJECT, input: 'demo-room.ply', format: 'webp', options: { image: { resolution: '99999999x1' } } });
        assert(status === 400, `expected 400, got ${status}`);
    });

    // ----- WebP image rendering (GPU rasterizer) -----
    if (!SKIP_GPU) {
        await check('WebP render (--camera-pos/--camera-target/--camera-fov)', async () => {
            const job = await runJob('/api/convert', { input: 'demo-room.ply', format: 'webp', options: { image: { camera: '2,1,-2', lookAt: '0,0,0', fov: 60, resolution: '320x180' } } });
            assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
            assert(fs.existsSync(path.join(projectDir, 'demo-room.webp')), 'no webp output');
        });
        await check('WebP DoF + motion-blur flags assemble & render', async () => {
            const job = await runJob('/api/convert', { input: 'demo-room.ply', format: 'webp', options: { image: { resolution: '160x90', fStop: 2.8, focusDistance: 3, cameraEnd: '3,1,-2', shutter: 0.5, motionSamples: 2 } } });
            assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
            assert(/--f-stop 2.8/.test(job.command) && /--camera-pos-end 3,1,-2/.test(job.command) && /--motion-samples 2/.test(job.command), `cmd: ${job.command}`);
        });
    } else {
        console.log('  - WebP render skipped (SKIP_GPU)');
    }

    if (!SKIP_GPU) {
        for (const preset of [
            { name: 'object', opts: { fillMode: 'none', carve: false, filterCluster: false } },
            { name: 'indoor', opts: { fillMode: 'external', fillSize: 1.6, carve: true, carveHeight: 1.6, carveRadius: 0.2, filterCluster: false } }
        ]) {
            await check(`collision preset: ${preset.name}`, async () => {
                const job = await runJob('/api/collision', {
                    input: 'demo-room.ply',
                    options: { voxelSize: 0.1, opacity: 0.1, seedPos: [0, 1, 0], meshShape: 'smooth', ...preset.opts }
                });
                assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
                assert(fs.existsSync(path.join(projectDir, 'collision.collision.glb')), 'no collision mesh');
                assert(fs.existsSync(path.join(projectDir, 'collision.voxel.json')), 'no voxel json');
            });
        }

        await check('collision region: filter-box (-B) actually crops the voxel grid', async () => {
            // keep only x >= 0; demo-room spans x ~ [-5.5, 4.5], so the voxel grid must shrink
            const job = await runJob('/api/collision', {
                input: 'demo-room.ply',
                options: {
                    voxelSize: 0.1, opacity: 0.1, seedPos: [0, 1, 0], meshShape: 'smooth',
                    fillMode: 'none', carve: false, filterCluster: false,
                    filterBox: ['0', '', '', '', '', '']
                }
            });
            assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
            assert(job.command.includes('-B 0,,,,,'), `no -B on collision cmd: ${job.command}`);
            const meta = JSON.parse(fs.readFileSync(path.join(projectDir, 'collision.voxel.json'), 'utf8'));
            assert(meta.gridBounds.min[0] > -2, `box not honored: grid min.x ${meta.gridBounds.min[0]} (expected > -2 after x>=0 crop)`);
        });
    } else {
        console.log('  - collision presets skipped (SKIP_GPU)');
    }
} finally {
    server?.kill();
    await fsp.rm(ws, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}\n`);
process.exit(failures.length ? 1 : 0);
