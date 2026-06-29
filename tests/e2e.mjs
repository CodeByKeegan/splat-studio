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

    await check('summary (-m) prints a stats table, writes nothing', async () => {
        const job = await runJob('/api/summary', { input: 'demo-room.ply' });
        assert(job.status === 'done', `job ${job.status}`);
        assert(/# Summary/.test(job.log) && /Row Count:/.test(job.log), 'no summary table in log');
        assert(job.outputs.length === 0, `summary wrote files: ${job.outputs}`);
    });

    await check('generator (.mjs) input + params (-p) synthesizes a splat', async () => {
        const job = await runJob('/api/convert', { input: 'gen-grid.mjs', format: 'ply', options: { params: 'width=10,height=10,scale=3' } });
        assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
        assert(fs.existsSync(path.join(projectDir, 'gen-grid.ply')), 'no generator output');
        const sum = await runJob('/api/summary', { input: 'gen-grid.ply' });
        const rc = (sum.log.match(/Row Count:\*\*\s*(\d+)/) || [])[1];
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
    await check('--verbose/--mem diagnostics flag', async () => {
        const job = await runJob('/api/convert', { input: 'demo-room.ply', format: 'ply', options: { verbose: true } });
        assert(job.status === 'done' && /--verbose/.test(job.command) && /--mem/.test(job.command), `cmd: ${job.command}`);
    });

    await check('HTML unbundled (-U) + viewer-settings (-E)', async () => {
        await fsp.writeFile(path.join(projectDir, 'settings.json'), '{}');
        const job = await runJob('/api/convert', { input: 'demo-room.ply', format: 'html', options: { unbundled: true, viewerSettings: 'settings.json' } });
        assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
        assert(/ -U\b/.test(job.command) && /-E settings\.json/.test(job.command), `cmd: ${job.command}`);
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

    await check('rejects an all-environment combine bake', async () => {
        const { status } = await api('POST', '/api/convert', {
            project: PROJECT, input: 'demo-room.ply', format: 'lod',
            options: { lodFiles: ['env-shell.ply'], lodEnvFlags: [true] }
        });
        assert(status === 400, `expected 400, got ${status}`);
    });

    await check('lists GPU adapters (-L)', async () => {
        const { json } = await api('GET', '/api/gpus');
        assert(Array.isArray(json.gpus), `gpus: ${JSON.stringify(json)}`);
    });

    await check('rejects a bad WebP resolution', async () => {
        const { status } = await api('POST', '/api/convert', { project: PROJECT, input: 'demo-room.ply', format: 'webp', options: { image: { resolution: '99999999x1' } } });
        assert(status === 400, `expected 400, got ${status}`);
    });

    // ----- WebP image rendering (GPU rasterizer) -----
    if (!SKIP_GPU) {
        await check('WebP render (--camera/--look-at/--fov)', async () => {
            const job = await runJob('/api/convert', { input: 'demo-room.ply', format: 'webp', options: { image: { camera: '2,1,-2', lookAt: '0,0,0', fov: 60, resolution: '320x180' } } });
            assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
            assert(fs.existsSync(path.join(projectDir, 'demo-room.webp')), 'no webp output');
        });
        await check('WebP DoF + motion-blur flags assemble & render', async () => {
            const job = await runJob('/api/convert', { input: 'demo-room.ply', format: 'webp', options: { image: { resolution: '160x90', fStop: 2.8, focusDistance: 3, cameraEnd: '3,1,-2', shutter: 0.5, motionSamples: 2 } } });
            assert(job.status === 'done', `job ${job.status}: ${(job.log || '').slice(-200)}`);
            assert(/--f-stop 2.8/.test(job.command) && /--camera-end 3,1,-2/.test(job.command) && /--motion-samples 2/.test(job.command), `cmd: ${job.command}`);
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
