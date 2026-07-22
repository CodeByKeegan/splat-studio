import express from 'express';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import { createJob, getJob, cancelJob, listJobs } from './jobs.mjs';
import { buildConvertCommand, buildCollisionCommand, buildSummaryCommand, buildTrimCommand, recordOutputs, cliPath } from './commands.mjs';
import { createRelay } from './editor-relay.mjs';
import { isControlEnabled, setControlEnabled } from './mcp-config.mjs';

// the MCP editor-control relay (created once the http.Server is listening below)
let relay = null;

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Each top-level subfolder of the workspace is a "project". The launcher
// (dev.cmd) and the packaged Electron app both set SPLAT_WORKSPACE to a real
// folder of projects; the ./workspace fallback only applies to a bare
// `node server/index.mjs`.
// runtime-switchable (POST /api/workspace) so the whole app can be re-pointed at a
// different folder without restarting — derived paths recompute in setWorkspaceDir
let workspaceDir = process.env.SPLAT_WORKSPACE
    ? path.resolve(process.env.SPLAT_WORKSPACE)
    : path.join(rootDir, 'workspace');
const distDir = path.join(rootDir, 'dist');
// per-workspace UI layout (dockable-editor arrangement). A root dotfile: it's a
// FILE so listProjects (which filters on isDirectory) never surfaces it.
let layoutFile = path.join(workspaceDir, '.splat-studio-layout.json');
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
        const abs = path.join(projectDir, ...rel.split('/'));
        const st = await fs.stat(abs);
        const entry = { name: rel, size: st.size, mtime: st.mtimeMs, kind: fileKind(rel), viewable: viewableAs(rel) };
        if (entry.kind === 'splat' || entry.kind === 'lod') {
            const counts = await countsFor(abs, st.mtimeMs, rel);
            if (counts?.gaussians !== undefined) entry.gaussians = counts.gaussians;
            if (counts?.lodCounts !== undefined) entry.lodCounts = counts.lodCounts;
        }
        return entry;
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

// ---------- cheap gaussian counts ----------
// Per-file gaussian counts for the files listing, read from format headers /
// metadata only — never by running the CLI. Cached per (path, mtime); null
// (no cheap count / unreadable) is cached too.
const countsCache = new Map();

// ranged fd read: [position, position + length)
const readRange = async (abs, position, length) => {
    const fh = await fs.open(abs, 'r');
    try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, position);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
};

// streamed-LOD lod-meta.json: total count + per-level counts
const readLodMetaCounts = async (abs) => {
    const meta = JSON.parse(await fs.readFile(abs, 'utf8'));
    if (!Number.isFinite(meta?.count)) return null;
    const value = { gaussians: meta.count };
    if (Array.isArray(meta.counts) && meta.counts.every(Number.isFinite)) value.lodCounts = meta.counts;
    return value;
};

// unbundled-SOG meta.json
const readSogMetaCounts = async (abs) => {
    const meta = JSON.parse(await fs.readFile(abs, 'utf8'));
    return Number.isFinite(meta?.count) ? { gaussians: meta.count } : null;
};

// .ply / .compressed.ply: "element vertex N" in the ascii header
const readPlyCounts = async (abs) => {
    const head = (await readRange(abs, 0, 64 * 1024)).toString('ascii');
    const end = head.indexOf('end_header');
    if (end < 0) return null;
    const m = head.slice(0, end).match(/^element vertex (\d+)$/m);
    return m ? { gaussians: Number(m[1]) } : null;
};

// .sog (ZIP): locate meta.json via the central directory using ranged reads
// only (archives can be GBs). ZIP64 (0xffffffff fields) out of scope -> null.
const readSogCounts = async (abs) => {
    const { size } = await fs.stat(abs);
    const tail = await readRange(abs, Math.max(0, size - 66 * 1024), Math.min(size, 66 * 1024));
    let eocd = -1; // scan backwards over a possible archive comment
    for (let i = tail.length - 22; i >= 0 && eocd < 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) eocd = i;
    }
    if (eocd < 0) return null;
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff || cdSize > 4 * 1024 * 1024 || cdOffset + cdSize > size) return null;
    const cd = await readRange(abs, cdOffset, cdSize);
    if (cd.length !== cdSize) return null;
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
        const method = cd.readUInt16LE(p + 10);
        const compSize = cd.readUInt32LE(p + 20);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        const localOffset = cd.readUInt32LE(p + 42);
        if (p + 46 + nameLen > cd.length) return null;
        if (cd.toString('utf8', p + 46, p + 46 + nameLen) === 'meta.json') {
            if (compSize === 0xffffffff || localOffset === 0xffffffff || compSize > 8 * 1024 * 1024) return null;
            const local = await readRange(abs, localOffset, 30);
            if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) return null;
            // data start uses the LOCAL header's name/extra lengths
            const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
            if (dataStart + compSize > size) return null;
            const data = await readRange(abs, dataStart, compSize);
            if (data.length !== compSize) return null;
            // cap the DECOMPRESSED size too — a real meta.json is a few KB
            const json = method === 0 ? data
                : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 8 * 1024 * 1024 }) : null;
            if (!json) return null;
            const meta = JSON.parse(json.toString('utf8'));
            return Number.isFinite(meta?.count) ? { gaussians: meta.count } : null;
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
};

// .splat (antimatter): fixed 32 bytes per gaussian
const readSplatCounts = async (abs) => {
    const { size } = await fs.stat(abs);
    return size > 0 && size % 32 === 0 ? { gaussians: size / 32 } : null;
};

// .spz: v4 leads with a plaintext NGSP header; v1-3 are gzip end-to-end with
// the same header at the start of the stream. numPoints at offset 8 either way.
const readSpzCounts = async (abs) => {
    let head = await readRange(abs, 0, 16 * 1024);
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
        head = zlib.gunzipSync(head, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 16 * 1024 * 1024 });
    }
    if (head.length < 12 || head.readUInt32LE(0) !== 0x5053474e) return null;
    return { gaussians: head.readUInt32LE(8) };
};

// dispatch by name; any failure -> null (a listing never rejects on a bad file)
const readCounts = async (abs, name) => {
    try {
        if (name.endsWith('lod-meta.json')) return await readLodMetaCounts(abs);
        if (name.endsWith('meta.json')) return await readSogMetaCounts(abs);
        if (/\.ply$/i.test(name)) return await readPlyCounts(abs);
        if (/\.sog$/i.test(name)) return await readSogCounts(abs);
        if (/\.splat$/i.test(name)) return await readSplatCounts(abs);
        if (/\.spz$/i.test(name)) return await readSpzCounts(abs);
        return null; // .ksplat/.lcc/.lcc2/.glb: no cheap header count
    } catch {
        return null;
    }
};

const countsFor = async (abs, mtime, name) => {
    const hit = countsCache.get(abs);
    if (hit && hit.mtime === mtime) return hit.value;
    const value = await readCounts(abs, name);
    countsCache.set(abs, { mtime, value });
    return value;
};

// ---------- per-file stats (cached) ----------
// Gaussian count + x/y/z extents from the CLI --stats table, for LOD auto-tune.
// Cached per (absolute path, mtime) so repeated auto-tunes don't re-run the scan.
const statsCache = new Map();
const parseStats = (log) => {
    // 3.0.0 --stats text: a "gaussians: N" header then a | Column | min | max | ... | table
    const rc = log.match(/^gaussians:\s*(\d+)/m);
    if (!rc) return null;
    const minMax = {};
    for (const line of log.split('\n')) {
        if (!line.trim().startsWith('|')) continue;
        const c = line.split('|').slice(1, -1).map((s) => s.trim());
        if (c.length < 3 || c[0] === 'Column' || /^-+$/.test(c[0])) continue;
        minMax[c[0]] = [Number(c[1]), Number(c[2])];
    }
    const extent = (k) => (minMax[k] ? minMax[k][1] - minMax[k][0] : NaN);
    const result = { count: Number(rc[1]), extents: [extent('x'), extent('y'), extent('z')] };
    // a partial/garbled parse → treat as failure (don't 200 + cache a NaN)
    return Number.isFinite(result.count) ? result : null;
};
const runStats = (absInput) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, '--no-tty', '-q', absInput, '--stats', 'text', 'null'], { windowsHide: true, timeout: 120000 });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', () => resolve(parseStats(out)));
});

// ---------- loopback guard (CSRF + DNS-rebinding) ----------
// The API can read/write files and spawn processes. It binds to 127.0.0.1, but a web
// page the user visits could still POST to it cross-origin (CSRF), or point a rebound
// DNS name at 127.0.0.1 to make its own requests same-origin (DNS rebinding). Require a
// loopback Host and reject any cross-origin browser request. Non-browser clients (curl,
// tests, the native MCP host) send no Origin and pass — same policy as the editor relay.
// Applied globally so /files and the dist static get the same rebinding protection.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const hostnameOf = (value, hasScheme) => {
    try { return new URL(hasScheme ? value : `http://${value}`).hostname; } catch { return null; }
};
app.use((req, res, next) => {
    if (!LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))) return res.status(403).json({ error: 'forbidden-host' });
    const source = req.headers.origin || req.headers.referer;
    if (source && !LOOPBACK_HOSTS.has(hostnameOf(source, true))) return res.status(403).json({ error: 'forbidden-origin' });
    next();
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

// re-point the whole app at a different workspace folder, live (no restart) — the
// derived layout/static paths recompute here so every subsequent request sees it
// persist the chosen workspace to the app config the packaged main process reads at
// launch (SPLAT_CONFIG_FILE) — so a switch survives a restart even if no renderer was
// connected to relay it back to Electron. Best-effort; dev/headless sets no file.
async function persistWorkspaceToConfig(dir) {
    const file = process.env.SPLAT_CONFIG_FILE;
    if (!file) return;
    try {
        let cfg = {};
        try { cfg = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* new/absent */ }
        cfg.workspace = dir;
        await fs.writeFile(file, JSON.stringify(cfg, null, 2));
    } catch { /* best-effort */ }
}

async function setWorkspaceDir(next, { create = false } = {}) {
    if (!path.isAbsolute(String(next))) throw new Error(`Not an absolute path: ${next}`);
    const resolved = path.resolve(String(next));
    let stat = null;
    try { stat = await fs.stat(resolved); } catch { /* missing */ }
    if (!stat) {
        if (!create) throw new Error(`No such folder: ${resolved}`);
        await fs.mkdir(resolved, { recursive: true });
    } else if (!stat.isDirectory()) {
        throw new Error(`Not a folder: ${resolved}`);
    }
    workspaceDir = resolved;
    layoutFile = path.join(workspaceDir, '.splat-studio-layout.json');
    filesStatic = express.static(workspaceDir, { fallthrough: false, dotfiles: 'deny' });
    await persistWorkspaceToConfig(workspaceDir);
    return workspaceDir;
}

app.get('/api/workspace', async (req, res) => {
    try {
        res.json({ path: workspaceDir, projects: await listProjects() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/workspace', json, async (req, res) => {
    const next = req.body?.path;
    if (!next || typeof next !== 'string') {
        return res.status(400).json({ error: 'path is required' });
    }
    try {
        const dir = await setWorkspaceDir(next, { create: !!req.body?.create });
        // fail-closed: a switch never silently carries over / adopts editor-control
        // consent (it's stored per-workspace) — the user must re-enable it deliberately
        await setControlEnabled(dir, false).catch(() => {});
        relay?.broadcast('workspace-switched', { path: dir });
        res.json({ path: dir, projects: await listProjects() });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
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
        const job = createJob({
            ...cmd,
            cwd: projectDir,
            onOutputs: recordOutputs,
            // live reflection: tell the editor when a job moves, and that the
            // workspace changed once outputs land (so the GUI refreshes its files)
            onStatus: (j) => {
                relay?.broadcast('job-updated', { id: j.id, status: j.status });
                if (j.status === 'done') relay?.broadcast('workspace-changed', { project: payload.project });
            }
        });
        res.json({ jobId: job.id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
};

app.post('/api/convert', json, (req, res) => startJob(res, buildConvertCommand, req.body ?? {}));
app.post('/api/collision', json, (req, res) => startJob(res, buildCollisionCommand, req.body ?? {}));
app.post('/api/summary', json, (req, res) => startJob(res, buildSummaryCommand, req.body ?? {}));
// region trim (carve out / keep inside a box/sphere) → a new .ply, via the Node worker
app.post('/api/trim', json, (req, res) => startJob(res, buildTrimCommand, req.body ?? {}));

// list GPU adapters (--list-gpus) so the UI can offer a device dropdown
const listGpus = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, '--no-tty', '--list-gpus'], { windowsHide: true, timeout: 15000 });
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

// ---------- location groups (project-scoped sidecar) ----------
// A "location group" is a set of source splats that are the same place at
// different detail (LODs). Edits made on a proxy fan out to every member. Stored
// as a project-root dotfile (.location-group.json) — fileKind() classifies it
// 'other', so listFiles never surfaces it, and /files denies dotfiles.
const groupsFile = (projectDir) => path.join(projectDir, '.location-group.json');

app.get('/api/groups', async (req, res) => {
    let projectDir;
    try { projectDir = resolveProject(req.query.project); }
    catch (err) { return res.status(400).json({ error: err.message }); }
    try {
        res.json(JSON.parse(await fs.readFile(groupsFile(projectDir), 'utf8')));
    } catch (err) {
        if (err.code === 'ENOENT') return res.json({ members: [], proxy: null }); // first run → empty
        res.status(500).json({ error: `Failed to read group: ${err.message}` }); // corrupt sidecar → 500, not 400
    }
});

app.post('/api/groups', json, async (req, res) => {
    let projectDir;
    try {
        projectDir = resolveProject(req.query.project);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
    const body = req.body;
    if (!body || !Array.isArray(body.members)) {
        return res.status(400).json({ error: 'members must be an array' });
    }
    for (const m of body.members) {
        if (!isSafeRelPath(String(m))) return res.status(400).json({ error: `Invalid member path: ${m}` });
    }
    if (body.proxy != null && !isSafeRelPath(String(body.proxy))) {
        return res.status(400).json({ error: `Invalid proxy path: ${body.proxy}` });
    }
    const data = { members: body.members.map(String), proxy: body.proxy ? String(body.proxy) : null };
    const tmp = `${groupsFile(projectDir)}.${Date.now().toString(36)}.tmp`;
    try {
        await fs.writeFile(tmp, JSON.stringify(data, null, 2)); // tmp + rename = atomic
        await fs.rename(tmp, groupsFile(projectDir));
        res.json({ ok: true });
    } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        res.status(500).json({ error: `Failed to save group: ${err.message}` });
    }
});

// ---------- MCP editor control channel ----------
// POST /api/editor/command forwards a command to the registered editor over the WS,
// gated by the consent toggle. GET /api/editor/status reports the binding; POST
// /api/editor/control flips the consent toggle (persisted per workspace).
app.post('/api/editor/command', json, async (req, res) => {
    const { name, params } = req.body ?? {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'command name is required' });
    if (!relay?.isConnected()) return res.status(409).json({ error: 'No editor is connected to Splat Studio' });
    if (!(await isControlEnabled(workspaceDir))) {
        return res.status(403).json({ error: 'Editor control is off — enable it in the app\'s MCP settings tab' });
    }
    const result = await relay.sendCommand(name, params ?? {});
    if (result.ok) return res.json({ ok: true, data: result.data });
    if (result.kind === 'no-editor') return res.status(409).json({ error: 'No editor is connected to Splat Studio' });
    if (result.kind === 'timeout') return res.status(504).json({ error: 'The editor did not respond in time' });
    if (result.kind) return res.status(400).json({ error: result.message || `editor command failed (${result.kind})` });
    // a tool-level ok:false from the editor handler -> 200 with the {error,message} body
    return res.status(200).json({ error: result.error, message: result.message });
});

app.get('/api/editor/status', async (req, res) => {
    const base = relay?.status() ?? { connected: false, editorProject: null, appVersion: null, lastSeenMs: null, port: PORT };
    res.json({ ...base, controlEnabled: await isControlEnabled(workspaceDir) });
});

app.post('/api/editor/control', json, async (req, res) => {
    const enabled = req.body?.enabled === true;
    try {
        await setControlEnabled(workspaceDir, enabled);
        res.json({ ok: true, controlEnabled: enabled });
    } catch (err) {
        res.status(500).json({ error: `Failed to persist consent: ${err.message}` });
    }
});

// files are served with the project as the first path segment; since projects
// are subfolders of workspaceDir, static resolves them directly (and brings its
// own traversal protection). The engine fetches bundle siblings (LOD chunks,
// unbundled-SOG textures) by relative URL, so project must be a path prefix.
// dotfiles:'deny' keeps the layout dotfile from being served over /files.
let filesStatic = express.static(workspaceDir, { fallthrough: false, dotfiles: 'deny' });
app.use('/files', (req, res, next) => filesStatic(req, res, next));

if (existsSync(distDir)) {
    app.use(express.static(distDir));
}

// loopback only: the API can write/delete files and spawn jobs — keep it off the LAN
const httpServer = app.listen(PORT, '127.0.0.1', () => {
    console.log(`splat-studio server listening on http://localhost:${PORT}`);
    console.log(`workspace: ${workspaceDir}`);
    listProjects().then((p) => console.log(`projects: ${p.join(', ') || '(none — create one in the UI)'}`));
    if (!existsSync(cliPath)) {
        console.warn('WARNING: splat-transform CLI not found — run npm install');
    }
});

// MCP editor-control relay shares the loopback http.Server (path /editor-ws), so
// it is never exposed on the LAN. The running GUI registers as the editor.
relay = createRelay(httpServer, { port: PORT });
