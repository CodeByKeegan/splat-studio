import express from 'express';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createJob, getJob, cancelJob, listJobs } from './jobs.mjs';
import { buildConvertCommand, buildCollisionCommand, buildSummaryCommand, recordOutputs, cliPath } from './commands.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Each top-level subfolder of the workspace is a "project". The launcher
// (dev.cmd) and the packaged Electron app both set SPLAT_WORKSPACE to a real
// folder of projects; the ./workspace fallback only applies to a bare
// `node server/index.mjs`.
const workspaceDir = process.env.SPLAT_WORKSPACE
    ? path.resolve(process.env.SPLAT_WORKSPACE)
    : path.join(rootDir, 'workspace');
const distDir = path.join(rootDir, 'dist');
// per-workspace UI layout (dockable-editor arrangement). A root dotfile: it's a
// FILE so listProjects (which filters on isDirectory) never surfaces it.
const layoutFile = path.join(workspaceDir, '.splat-studio-layout.json');
await fs.mkdir(workspaceDir, { recursive: true });

// deliberately not PORT: dev harnesses set that for the frontend (vite on 5173)
const PORT = Number(process.env.API_PORT ?? 5174);
const app = express();
// not global: it would consume /api/upload bodies whose Content-Type is
// application/json (uploading an unbundled-SOG meta.json)
const json = express.json();

// ---------- path safety ----------
const SAFE_SEGMENT = /^[A-Za-z0-9()._ -]+$/;

const isSafeSegment = (s) => SAFE_SEGMENT.test(s) && s !== '.' && s !== '..';

// project-relative path (e.g. "RAW SOG/HOTP_10mil.sog"); a few levels deep for
// nested sources and unbundled-SOG / LOD entry points
const isSafeRelPath = (rel, maxDepth = 4) => {
    const segments = String(rel).split('/');
    return segments.length >= 1 && segments.length <= maxDepth && segments.every(isSafeSegment);
};

// ---------- projects ----------
const projectAbs = (project) => {
    if (!isSafeSegment(String(project))) throw new Error(`Invalid project name: ${project}`);
    return path.join(workspaceDir, project);
};

// an output bundle (streamed LOD / unbundled SOG) is NOT a project — guard
// against one ever being listed as one if the workspace root is mispointed
const isOutputBundle = async (dir) => {
    let names;
    try { names = await fs.readdir(dir); } catch { return false; }
    if (names.includes('lod-meta.json')) return true;
    return names.includes('meta.json') && names.some((n) => n.endsWith('.webp'));
};

const listProjects = async () => {
    const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && isSafeSegment(e.name));
    const projects = [];
    for (const e of dirs) {
        if (!(await isOutputBundle(path.join(workspaceDir, e.name)))) projects.push(e.name);
    }
    return projects.sort((a, b) => a.localeCompare(b));
};

// resolve & validate the project for a request; throws (-> 400) if missing/unknown
const resolveProject = (project) => {
    const abs = projectAbs(project);
    if (!existsSync(abs)) throw new Error(`No such project: ${project}`);
    return abs;
};

const toAbs = (projectDir, rel) => path.join(projectDir, ...rel.split('/'));

// ---------- file listing ----------
const fileKind = (name) => {
    if (name.endsWith('.voxel.json') || name.endsWith('.voxel.bin')) return 'voxel';
    if (name.endsWith('.collision.glb')) return 'collision';
    if (name.endsWith('lod-meta.json')) return 'lod';
    if (name.endsWith('meta.json')) return 'splat';
    if (/\.(ply|sog|spz|splat|ksplat|lcc2?)$/i.test(name)) return 'splat';
    if (name.endsWith('.glb')) return 'glb';
    if (/\.(csv|html|webp)$/i.test(name)) return 'export';
    if (/\.mjs$/i.test(name)) return 'generator'; // procedural splat source (-p params)
    return 'other';
};

const viewableAs = (name) => {
    if (name.endsWith('.collision.glb')) return 'collision';
    if (name.endsWith('.voxel.json')) return 'voxel';
    if (name.endsWith('lod-meta.json')) return 'splat';
    if (/\.ply$/i.test(name) || name.endsWith('.sog') || name.endsWith('meta.json')) return 'splat';
    return null;
};

// Walk a project, surfacing primary assets. Output bundles collapse to their
// entry point: a folder with lod-meta.json (streamed LOD) or meta.json+webp
// (unbundled SOG) yields just that file and isn't descended into. Everything
// else (incl. nested source folders like "RAW SOG") is listed by file kind.
const listFiles = async (projectDir) => {
    const out = [];
    const statEntry = async (rel) => {
        const st = await fs.stat(path.join(projectDir, ...rel.split('/')));
        return { name: rel, size: st.size, mtime: st.mtimeMs, kind: fileKind(rel), viewable: viewableAs(rel) };
    };
    const walk = async (dir, prefix, depth) => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        const names = entries.map((e) => e.name);
        if (prefix && names.includes('lod-meta.json')) {
            out.push(await statEntry(`${prefix}/lod-meta.json`));
            return; // don't descend into the chunk subfolders
        }
        if (prefix && names.includes('meta.json') && names.some((n) => n.endsWith('.webp'))) {
            out.push(await statEntry(`${prefix}/meta.json`));
            return; // unbundled SOG: textures stay hidden
        }
        for (const e of entries) {
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) {
                if (depth < 4 && isSafeSegment(e.name)) await walk(path.join(dir, e.name), rel, depth + 1);
            } else if (isSafeSegment(e.name) && fileKind(rel) !== 'other') {
                out.push(await statEntry(rel));
            }
        }
    };
    await walk(projectDir, '', 0);
    return out.sort((a, b) => a.name.localeCompare(b.name));
};

// ---------- per-file stats (cached) ----------
// Gaussian count + x/y/z extents from the CLI summary (-m), for LOD auto-tune.
// Cached per (absolute path, mtime) so repeated auto-tunes don't re-run the scan.
const statsCache = new Map();
const parseStats = (log) => {
    const start = log.indexOf('# Summary');
    if (start < 0) return null;
    const block = log.slice(start);
    const rc = block.match(/Row Count:\*\*\s*(\d+)/);
    const minMax = {};
    for (const line of block.split('\n')) {
        if (!line.trim().startsWith('|')) continue;
        const c = line.split('|').slice(1, -1).map((s) => s.trim());
        if (c.length < 3 || c[0] === 'Column' || /^-+$/.test(c[0])) continue;
        minMax[c[0]] = [Number(c[1]), Number(c[2])];
    }
    const extent = (k) => (minMax[k] ? minMax[k][1] - minMax[k][0] : NaN);
    const result = { count: rc ? Number(rc[1]) : NaN, extents: [extent('x'), extent('y'), extent('z')] };
    // a partial/garbled summary parse → treat as failure (don't 200 + cache a NaN)
    return Number.isFinite(result.count) ? result : null;
};
const runStats = (absInput) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, '--no-tty', '-q', absInput, '-m', 'null'], { windowsHide: true, timeout: 120000 });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(parseStats(out)));
});

// ---------- routes ----------
app.get('/api/health', (req, res) => {
    res.json({ ok: true, cli: existsSync(cliPath) });
});

// component versions for the Settings/About section. PlayCanvas is a build-time
// dep (bundled into the client; the packaged app prunes it from node_modules),
// so the client reads its version from the engine; these two are always present.
app.get('/api/versions', async (req, res) => {
    const ver = async (rel) => {
        try { return JSON.parse(await fs.readFile(path.join(rootDir, rel), 'utf8')).version || null; }
        catch { return null; }
    };
    res.json({
        app: await ver('package.json'),
        splatTransform: await ver('node_modules/@playcanvas/splat-transform/package.json')
    });
});

app.get('/api/projects', async (req, res) => {
    try {
        res.json({ projects: await listProjects() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/projects', json, async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!isSafeSegment(name)) {
        return res.status(400).json({ error: 'Invalid project name (letters, numbers, spaces, ( ) . _ - only)' });
    }
    try {
        await fs.mkdir(path.join(workspaceDir, name)); // throws EEXIST if it already exists
        res.json({ name });
    } catch (err) {
        if (err.code === 'EEXIST') return res.status(409).json({ error: `Project already exists: ${name}` });
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/files', async (req, res) => {
    try {
        const projectDir = resolveProject(req.query.project);
        res.json({ files: await listFiles(projectDir) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

const MAX_UPLOAD = 8 * 1024 ** 3;

app.post('/api/upload', async (req, res) => {
    let projectDir;
    try {
        projectDir = resolveProject(req.query.project);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
    const name = String(req.query.name ?? '');
    if (!isSafeRelPath(name, 1)) {
        return res.status(400).json({ error: 'Invalid file name' });
    }
    // stream to a temp file and rename into place, so aborted uploads never
    // leave a truncated file behind (or clobber one a running job is reading)
    const target = toAbs(projectDir, name);
    const tmp = `${target}.${Date.now().toString(36)}.uploading`;
    let received = 0;
    const limiter = new Transform({
        transform(chunk, encoding, done) {
            received += chunk.length;
            if (received > MAX_UPLOAD) done(new Error('upload exceeds size limit'));
            else done(null, chunk);
        }
    });
    try {
        await pipeline(req, limiter, createWriteStream(tmp, { flags: 'wx' }));
        await fs.rename(tmp, target);
        res.json({ name });
    } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        res.status(500).json({ error: `Upload failed: ${err.message}` });
    }
});

app.delete(/^\/api\/files\/(.+)$/, async (req, res) => {
    let projectDir;
    try {
        projectDir = resolveProject(req.query.project);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
    const rel = req.params[0]; // express has already percent-decoded the capture
    if (!isSafeRelPath(rel)) return res.status(400).json({ error: 'Invalid path' });
    const abs = toAbs(projectDir, rel);
    if (!existsSync(abs)) return res.status(404).json({ error: 'Not found' });
    // deleting an unbundled SOG's / LOD's entry point removes its folder
    const isDirEntry = rel.includes('/') && (rel.endsWith('meta.json') || rel.endsWith('lod-meta.json'));
    await fs.rm(isDirEntry ? path.dirname(abs) : abs, { recursive: true, force: true });
    res.json({ ok: true });
});

const startJob = async (res, build, payload) => {
    try {
        const projectDir = resolveProject(payload.project);
        // every referenced file must be safe and present within the project
        // (combine-mode LOD jobs reference extra inputs via options.lodFiles)
        const inputs = [String(payload.input ?? ''), ...(payload.options?.lodFiles ?? []).map(String)];
        for (const input of inputs) {
            if (!isSafeRelPath(input) || !existsSync(toAbs(projectDir, input))) {
                return res.status(400).json({ error: `Input not found: ${input}` });
            }
        }
        // the CLI creates output subdirs itself (-w runs mkdir -p on the target dir)
        const cmd = build({ ...payload, workspaceDir: projectDir });
        // folder-shaped outputs (streamed LOD) can leave stale chunk dirs when
        // regenerated with different settings — clear them first
        for (const dir of cmd.cleanDirs ?? []) {
            if (isSafeRelPath(dir, 1)) {
                await fs.rm(toAbs(projectDir, dir), { recursive: true, force: true });
            }
        }
        const job = createJob({ ...cmd, cwd: projectDir, onOutputs: recordOutputs });
        res.json({ jobId: job.id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

app.post('/api/convert', json, (req, res) => startJob(res, buildConvertCommand, req.body ?? {}));
app.post('/api/collision', json, (req, res) => startJob(res, buildCollisionCommand, req.body ?? {}));
app.post('/api/summary', json, (req, res) => startJob(res, buildSummaryCommand, req.body ?? {}));

// list GPU adapters (-L/--list-gpus) so the UI can offer a device dropdown
const listGpus = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, '--no-tty', '-L'], { windowsHide: true, timeout: 15000 });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve([]));
    child.on('close', () => {
        const gpus = [];
        for (const line of out.split('\n')) {
            const m = line.match(/^\s*\[(\d+)\]\s+(.+?)\s*$/);
            if (m) gpus.push({ index: Number(m[1]), name: m[2] });
        }
        resolve(gpus);
    });
});
app.get('/api/gpus', async (req, res) => res.json({ gpus: await listGpus() }));

// gaussian count + x/y/z extents for one splat (drives LOD auto-tune); cached by path+mtime
app.get('/api/stats', async (req, res) => {
    try {
        const projectDir = resolveProject(req.query.project);
        const input = String(req.query.input ?? '');
        if (!isSafeRelPath(input) || !existsSync(toAbs(projectDir, input))) {
            return res.status(400).json({ error: `No such file: ${input}` });
        }
        const abs = toAbs(projectDir, input);
        const mtime = (await fs.stat(abs)).mtimeMs;
        const hit = statsCache.get(abs);
        if (hit && hit.mtime === mtime) return res.json(hit.stats);
        const stats = await runStats(abs);
        if (!stats) return res.status(500).json({ error: `Could not analyze ${input}` });
        statsCache.set(abs, { mtime, stats });
        res.json(stats);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Read a .mjs generator's advertised param schema (its static `Generator.params`)
// by importing it in a throwaway child Node: isolates a crashing/looping module
// (5s timeout) and dodges the ESM cache so an edited generator re-reads. Lets the
// UI render live sliders for generators that opt in. Returns null on any failure.
const readGeneratorParams = (absPath) => new Promise((resolve) => {
    const url = pathToFileURL(absPath).href;
    const code = `import(${JSON.stringify(url)}).then(m => process.stdout.write(JSON.stringify(m.Generator?.params ?? null))).catch(() => process.stdout.write('null'));`;
    const child = spawn(process.execPath, ['-e', code], { windowsHide: true, timeout: 5000 });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', () => { try { resolve(JSON.parse(out || 'null')); } catch { resolve(null); } });
});

app.get('/api/generator-params', async (req, res) => {
    try {
        const projectDir = resolveProject(req.query.project);
        const input = String(req.query.input ?? '');
        if (!isSafeRelPath(input) || !/\.mjs$/i.test(input) || !existsSync(toAbs(projectDir, input))) {
            return res.status(400).json({ error: 'Not a generator file' });
        }
        res.json({ params: await readGeneratorParams(toAbs(projectDir, input)) });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/jobs', (req, res) => res.json({ jobs: listJobs() }));

app.get('/api/jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'No such job' });
    res.json(job);
});

app.post('/api/jobs/:id/cancel', (req, res) => {
    if (!getJob(req.params.id)) return res.status(404).json({ error: 'No such job' });
    res.json({ cancelled: cancelJob(req.params.id) });
});

// ---------- per-workspace UI layout ----------
app.get('/api/layout', async (req, res) => {
    try {
        res.json(JSON.parse(await fs.readFile(layoutFile, 'utf8')));
    } catch (err) {
        if (err.code === 'ENOENT') return res.json({}); // first run → client applies defaults
        res.status(500).json({ error: `Failed to read layout: ${err.message}` });
    }
});

app.post('/api/layout', json, async (req, res) => {
    const layout = req.body;
    if (layout === null || typeof layout !== 'object' || Array.isArray(layout)) {
        return res.status(400).json({ error: 'Layout must be a JSON object' });
    }
    const tmp = `${layoutFile}.${Date.now().toString(36)}.tmp`;
    try {
        await fs.writeFile(tmp, JSON.stringify(layout, null, 2)); // tmp + rename = atomic
        await fs.rename(tmp, layoutFile);
        res.json({ ok: true });
    } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        res.status(500).json({ error: `Failed to save layout: ${err.message}` });
    }
});

// files are served with the project as the first path segment; since projects
// are subfolders of workspaceDir, static resolves them directly (and brings its
// own traversal protection). The engine fetches bundle siblings (LOD chunks,
// unbundled-SOG textures) by relative URL, so project must be a path prefix.
// dotfiles:'deny' keeps the layout dotfile from being served over /files.
app.use('/files', express.static(workspaceDir, { fallthrough: false, dotfiles: 'deny' }));

if (existsSync(distDir)) {
    app.use(express.static(distDir));
}

// loopback only: the API can write/delete files and spawn jobs — keep it off the LAN
app.listen(PORT, '127.0.0.1', () => {
    console.log(`splat-studio server listening on http://localhost:${PORT}`);
    console.log(`workspace: ${workspaceDir}`);
    listProjects().then((p) => console.log(`projects: ${p.join(', ') || '(none — create one in the UI)'}`));
    if (!existsSync(cliPath)) {
        console.warn('WARNING: splat-transform CLI not found — run npm install');
    }
});
