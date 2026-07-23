// Command builders: translate each API job payload (convert / LOD / collision /
// summary / trim) into a validated splat-transform CLI argv (or trim-worker
// invocation). Builders assume the route layer (startJob) has already validated
// and resolved the input paths.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// outputs produced by jobs this session — overwriting these again is intended
const priorOutputs = new Set();
// mark job outputs as app-generated (fed back by the job runner's onOutputs)
export const recordOutputs = (names) => names.forEach((n) => priorOutputs.add(n));

// The CLI handles WebGPU device creation (native Dawn bindings) itself, so we
// spawn it rather than driving the programmatic API.
export const cliPath = path.join(rootDir, 'node_modules', '@playcanvas', 'splat-transform', 'bin', 'cli.mjs');

// Region trim runs in-process (Node, no CLI/GPU) via a spawned worker, so it slots
// into the same job system as the CLI commands. See server/ply-trim.mjs.
export const trimWorkerPath = path.join(rootDir, 'server', 'ply-trim-worker.mjs');

// number with default, clamped to [min, max]; throws on non-numeric input
const num = (value, fallback, min, max) => {
    const n = Number(value ?? fallback);
    if (!Number.isFinite(n)) throw new Error(`Invalid number: ${value}`);
    return Math.min(max, Math.max(min, n));
};

// "x,y,z" (or "r,g,b[,a]") validator — values pass straight to the CLI as args
const csv = (value, label, count) => {
    const s = String(value ?? '').trim();
    const parts = s.split(',');
    if (parts.length < count || parts.length > count + 1 || parts.some((p) => !/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(p.trim()))) {
        throw new Error(`Invalid ${label}: ${value} (expected ${count} comma-separated numbers)`);
    }
    return s;
};

// Output base name, always at the PROJECT ROOT (subfolders like "RAW SOG/" are
// stripped so generated artifacts sit at the top of the project, not buried
// beside their source). 'RAW SOG/room.compressed.ply' -> 'room';
// 'room-sog/meta.json' -> 'room'; 'scene-lod/lod-meta.json' -> 'scene'.
const baseName = (input) => {
    const file = input.split('/').pop();
    if (file === 'meta.json' || file === 'lod-meta.json') {
        const dir = input.split('/').slice(-2, -1)[0] ?? 'splat';
        return dir.replace(/-sog$/, '').replace(/-lod$/, '');
    }
    return file.replace(/\.compressed\.ply$/i, '').replace(/\.[^./]+$/, '');
};

// output filename per convert format, from the input's base name
const OUTPUT_NAMES = {
    'ply': (base) => `${base}.ply`,
    'compressed-ply': (base) => `${base}.compressed.ply`,
    'sog': (base) => `${base}.sog`,
    'sog-unbundled': (base) => `${base}-sog/meta.json`,
    'lod': (base) => `${base}-lod/lod-meta.json`,
    'spz': (base) => `${base}.spz`,
    'glb': (base) => `${base}.glb`,
    'csv': (base) => `${base}.csv`,
    'html': (base) => `${base}.html`,
    'webp': (base) => `${base}.webp`
};

// never clobber the input, and don't silently overwrite a pre-existing file this
// app didn't produce (e.g. compressed.ply -> ply landing on the original source);
// re-running the same conversion stays idempotent
const outputCollides = (name, input, workspaceDir) => name === input ||
    (workspaceDir && !priorOutputs.has(name) && existsSync(path.join(workspaceDir, ...name.split('/'))));

// .mjs generator parameters (-p key=val,...): a per-input action, pushed right
// after the input token
const pushGeneratorParams = (args, input, options) => {
    if (!/\.mjs$/i.test(input) || options.params == null || options.params === '') return;
    const p = String(options.params).trim();
    if (!/^[A-Za-z0-9_]+=[^,=]+(,[A-Za-z0-9_]+=[^,=]+)*$/.test(p)) {
        throw new Error(`Invalid generator params: ${p} (use key=val,key=val)`);
    }
    args.push('-p', p);
};

// [x, y, z] of finite numbers; throws otherwise
const vec3Arg = (v, name) => {
    if (!Array.isArray(v) || v.length !== 3) throw new Error(`${name} needs 3 numbers`);
    return v.map((x) => {
        const n = Number(x);
        if (!Number.isFinite(n)) throw new Error(`${name}: invalid number "${x}"`);
        return n;
    });
};

// device: 'cpu' | 'auto' | a GPU adapter index (from -L/--list-gpus). Shared by the
// main command and the LOD decimate pre-commands, which spawn their own CLI process
// and must honor the same device choice (--decimate defaults to trying GPU init
// otherwise, even though it runs fine on CPU). Returns the effective device.
const pushDeviceFlag = (args, options) => {
    if (options.device === 'cpu') {
        args.push('-g', 'cpu');
        return 'cpu';
    }
    if (options.device != null && options.device !== '' && options.device !== 'auto') {
        const idx = Math.round(num(options.device, 0, 0, 64));
        args.push('-g', String(idx));
        return idx;
    }
    return 'auto';
};

// --scratch-dir: decimation spill directory. Deliberately NOT workspace-guarded —
// pointing spill at another volume is the point. Absolute + existing dir only.
// Callers consult it only when --decimate is active; blank/unset returns null.
const scratchDirArg = (options) => {
    const s = String(options.scratchDir ?? '').trim();
    if (!s) return null;
    if (!path.isAbsolute(s)) throw new Error(`Invalid scratch directory: ${s} (must be an absolute path)`);
    let st = null;
    try { st = statSync(s); } catch { /* missing */ }
    if (!st?.isDirectory()) throw new Error(`Scratch directory not found: ${s} (must be an existing directory)`);
    return s;
};

// -B/-S spatial crop, shared by convert and collision. They are per-input filter
// actions, so callers push them between the input token and the output token.
const pushCropFilters = (args, options) => {
    if (Array.isArray(options.filterBox)) {
        if (options.filterBox.length !== 6) throw new Error('filter-box needs 6 values (min x,y,z, max x,y,z)');
        // blank or "-" leaves that side unbounded (the CLI maps it to ±Infinity)
        const parts = options.filterBox.map((s) => {
            const t = String(s ?? '').trim();
            if (t === '' || t === '-') return '';
            const n = Number(t);
            if (!Number.isFinite(n)) throw new Error(`filter-box: invalid number "${t}"`);
            return String(n);
        });
        if (parts.every((p) => p === '')) throw new Error('filter-box: set at least one bound');
        args.push('-B', parts.join(','));
    }

    const sph = options.filterSphere;
    if (Array.isArray(sph)) {
        if (sph.length !== 4) throw new Error('filter-sphere needs 4 values (x, y, z, radius)');
        const v = sph.map((x) => {
            const n = Number(x);
            if (!Number.isFinite(n)) throw new Error(`filter-sphere: invalid number "${x}"`);
            return n;
        });
        if (v[3] < 0) throw new Error('filter-sphere: radius must be >= 0');
        args.push('-S', v.join(','));
    }
};

// Transform/filter actions applied to the working set before the output is
// written (CLI grammar: input [ACTIONS] output). Fixed pipeline order; only
// non-default values emit a flag. Not used by the LOD path, which bakes levels
// of its own.
const pushConvertActions = (args, options) => {
    if (options.filterNaN) args.push('-N');

    const tr = options.translate;
    if (Array.isArray(tr) && tr.some((v) => Number(v) !== 0)) {
        args.push('-t', vec3Arg(tr, 'translate').join(','));
    }

    const rot = options.rotate;
    if (Array.isArray(rot) && rot.some((v) => Number(v) !== 0)) {
        args.push('-r', vec3Arg(rot, 'rotate').join(','));
    }

    if (options.scale != null && options.scale !== '' && Number(options.scale) !== 1) {
        const s = Number(options.scale);
        if (!Number.isFinite(s) || s <= 0) throw new Error(`Invalid scale value: ${options.scale} (must be greater than 0)`);
        args.push('-s', String(s));
    }

    if (options.filterHarmonics != null && options.filterHarmonics !== '') {
        const h = Number(options.filterHarmonics);
        if (![0, 1, 2, 3].includes(h)) throw new Error(`Invalid filter-harmonics value: ${options.filterHarmonics} (must be 0-3)`);
        args.push('-H', String(h));
    }

    pushCropFilters(args, options);

    const fv = options.filterValue;
    if (fv && typeof fv === 'object') {
        const col = String(fv.column ?? '').trim();
        if (!/^[A-Za-z0-9_]+$/.test(col)) throw new Error(`filter-value: invalid column name "${fv.column}"`);
        if (!['lt', 'lte', 'gt', 'gte', 'eq', 'neq'].includes(fv.comparator)) {
            throw new Error(`filter-value: invalid comparator "${fv.comparator}"`);
        }
        const val = Number(fv.value);
        if (!Number.isFinite(val)) throw new Error(`filter-value: invalid value "${fv.value}"`);
        // the CLI inverse-transforms the linear opacity and rejects values outside (0,1)
        if (col === 'opacity' && (val <= 0 || val >= 1)) {
            throw new Error('filter-value: transformed opacity must be between 0 and 1 (use opacity_raw for stored values)');
        }
        args.push('-V', `${col},${fv.comparator},${val}`);
    }

    const ff = options.filterFloaters;
    if (ff && typeof ff === 'object') {
        // GPU-only pass — fail fast rather than let the CLI throw mid-run
        if (options.device === 'cpu') throw new Error('Remove floaters needs the GPU — uncheck "CPU only"');
        const has = (x) => x != null && String(x).trim() !== '';
        if (!has(ff.size) && !has(ff.opacity) && !has(ff.min)) {
            args.push('--filter-floaters'); // bare flag → CLI defaults (0.05, 0.1, 0.004)
        } else {
            const size = has(ff.size) ? Number(ff.size) : 0.05;
            const op = has(ff.opacity) ? Number(ff.opacity) : 0.1;
            const min = has(ff.min) ? Number(ff.min) : 0.004;
            if (!(size > 0)) throw new Error('filter-floaters: voxel size must be greater than 0');
            if (!Number.isFinite(op) || op < 0 || op > 1) throw new Error('filter-floaters: opacity must be in [0, 1]');
            if (!Number.isFinite(min) || min < 0) throw new Error('filter-floaters: min contribution must be >= 0');
            args.push('--filter-floaters', `${size},${op},${min}`);
        }
    }

    // morton before decimate: the CLI requires --decimate to be the final action
    if (options.mortonOrder) args.push('--morton-order');

    if (options.decimate != null && options.decimate !== '') {
        const d = String(options.decimate).trim();
        if (!/^\d+%?$/.test(d)) throw new Error(`Invalid decimate value: ${d} (use a count or percentage like 50%)`);
        // must be the final action, and requires .ply output (guarded in buildConvertCommand)
        args.push('--decimate', d);
        const sd = scratchDirArg(options);
        if (sd) args.push('--scratch-dir', sd); // spill location (global option)
    }
};

// Build the convert/LOD/render argv for one job.
// CLI grammar: splat-transform [GLOBAL] input [ACTIONS] output [ACTIONS]
export const buildConvertCommand = ({ input, format, options = {}, workspaceDir }) => {
    const makeName = Object.hasOwn(OUTPUT_NAMES, format) ? OUTPUT_NAMES[format] : null;
    if (!makeName) throw new Error(`Unknown output format: ${format}`);

    // --decimate writes a decimated PLY only (final action, .ply output), so
    // block it up front for any other convert format with a clear message.
    if (options.decimate != null && options.decimate !== '' && format !== 'ply') {
        throw new Error('Decimate writes a PLY only — choose PLY output, or decimate to PLY first then convert');
    }

    const base = baseName(input);
    let output = makeName(base);
    if (outputCollides(output, input, workspaceDir)) output = makeName(`${base}-converted`);

    const args = [cliPath, '--no-tty', '-w'];
    if (options.verbose) args.push('--verbose', '--memory'); // diagnostics
    const device = pushDeviceFlag(args, options);
    let iterations, maxWorkers;
    if (format === 'sog' || format === 'sog-unbundled' || format === 'html' || format === 'lod') {
        iterations = Math.round(num(options.iterations, 10, 1, 100));
        args.push('-i', String(iterations));
        // SOG encoder worker threads (--max-workers); 0 = inline/serial
        if (options.maxWorkers != null && options.maxWorkers !== '') {
            maxWorkers = Math.round(num(options.maxWorkers, 4, 0, 64));
            args.push('--max-workers', String(maxWorkers));
        }
    }
    if (format === 'html') {
        if (options.unbundled) args.push('--unbundled'); // separate files instead of one .html
        if (options.viewerSettings) { // --viewer-settings settings.json (project-relative)
            const vs = String(options.viewerSettings).trim();
            if (!/^[A-Za-z0-9()._ /-]+\.json$/i.test(vs) || vs.includes('..')) {
                throw new Error(`Invalid viewer-settings path: ${vs}`);
            }
            args.push('--viewer-settings', vs);
        }
    }
    if (format === 'spz') {
        const v = Number(options.spzVersion ?? 4);
        if (v !== 3 && v !== 4) throw new Error(`Invalid SPZ version: ${options.spzVersion}`);
        args.push('--spz-version', String(v));
    }

    if (format === 'lod') {
        const chunkCount = Math.round(num(options.lodChunkCount, 512, 16, 8192));
        // the CLI parses --lod-chunk-extent with parseInteger; fractional input must be rounded
        const chunkExtent = Math.round(num(options.lodChunkExtent, 16, 1, 1000));
        args.push('--lod-chunk-count', String(chunkCount));
        args.push('--lod-chunk-extent', String(chunkExtent));
        const lodDir = output.split('/')[0];
        // build recipe skeleton — gaussians/createdAt/generator fill in at write time
        const settings = { iterations, maxWorkers, device, chunkCount, chunkExtent, filterNaN: !!options.filterNaN };
        const buildMetaName = `${lodDir}/build-meta.json`;

        const rawFiles = Array.isArray(options.lodFiles) ? options.lodFiles : null;
        const rawEnv = Array.isArray(options.lodEnvFlags) ? options.lodEnvFlags : [];
        // pair each file with its environment flag, then drop blank rows so a
        // missing selection can't desync the file <-> flag mapping
        const pairs = (rawFiles ?? [])
            .map((file, i) => ({ file, env: rawEnv[i] === true }))
            .filter((p) => p.file);
        // lodFiles present-but-empty means combine mode with no levels — reject
        // rather than silently falling through to decimate mode
        if (rawFiles && pairs.length === 0) {
            throw new Error('Combine mode requires at least one additional LOD level file');
        }
        // an environment shell (-l -1) needs at least one streamed detail level beside it
        if (pairs.length > 0 && pairs.every((p) => p.env)) {
            throw new Error('Combine mode needs at least one non-environment LOD level');
        }
        if (pairs.length > 0) {
            // combine mode: pre-authored levels — input is LOD 0; each added file
            // is the next positive level, except one flagged "environment" which is
            // tagged -l -1 (the runtime keeps it resident as a far/background shell
            // instead of streaming it by camera distance). nextLevel (not the array
            // index) keeps positive levels gap-free around an environment row.
            args.push(input);
            if (options.filterNaN) args.push('-N');
            args.push('-l', '0');
            const metaLevels = [{ level: 0, source: input }];
            const envLevels = [];
            let nextLevel = 1;
            for (const { file, env } of pairs) {
                args.push(file);
                if (options.filterNaN) args.push('-N');
                if (env) {
                    args.push('-l', '-1');
                    envLevels.push({ level: -1, source: file, environment: true });
                } else {
                    args.push('-l', String(nextLevel));
                    metaLevels.push({ level: nextLevel++, source: file });
                }
            }
            args.push(output);
            return {
                title: `Streamed LOD (combine ${pairs.length + 1} files${envLevels.length ? ', +environment' : ''}) → ${output}`,
                args,
                expectedOutputs: [output],
                viewables: viewableOutputs([output]),
                // chunk folder names vary with settings; clear stale ones on re-run
                cleanDirs: [lodDir],
                // environment rows sort last
                buildMeta: { version: 1, mode: 'combine', input, levels: [...metaLevels, ...envLevels], settings },
                buildMetaName
            };
        }

        // decimate mode: the CLI requires --decimate to be the final action writing
        // a .ply, so it can't run inline while tagging LOD levels. Pre-decimate each
        // level to a temp .ply in a sibling <lod>-src dir, then combine the raw input
        // (level 0) with those pre-authored levels in one invocation.
        const levels = Math.round(num(options.lodLevels, 3, 1, 8));
        const keep = num(options.lodKeepPercent, 50, 5, 95);
        const tmpDir = `${lodDir}-src`;
        const tmp = (level) => `${tmpDir}/l${level}.ply`;

        const sd = scratchDirArg(options); // each pre-command decimates
        // provenance is the original input at each level's kept percentage — the
        // l<n>.ply temps are plumbing
        const metaLevels = [{ level: 0, source: input, keepPercent: 100 }];
        const preCommands = [];
        for (let level = 1; level < levels; level++) {
            const pct = Math.max(1, Math.round(((keep / 100) ** level) * 100));
            metaLevels.push({ level, source: input, keepPercent: pct });
            const a = [cliPath, '--no-tty', '-w', '-q'];
            pushDeviceFlag(a, options);
            if (sd) a.push('--scratch-dir', sd);
            a.push(input);
            if (options.filterNaN) a.push('-N');
            a.push('--decimate', `${pct}%`, tmp(level)); // decimate is the final action, .ply output
            preCommands.push({ args: a });
        }
        // combine: raw input is level 0; each pre-decimated temp is the next level
        args.push(input);
        if (options.filterNaN) args.push('-N');
        args.push('-l', '0');
        for (let level = 1; level < levels; level++) args.push(tmp(level), '-l', String(level));
        args.push(output);
        return {
            title: `Streamed LOD (${levels} levels, decimated) ${input} → ${output}`,
            preCommands,
            args,
            expectedOutputs: [output],
            viewables: viewableOutputs([output]),
            // clear stale chunk dirs AND stale temps before the run
            cleanDirs: [lodDir, tmpDir],
            // remove the temp .ply dir after the job finishes
            tempDirs: [tmpDir],
            buildMeta: {
                version: 1,
                mode: 'decimate',
                input,
                levels: metaLevels,
                settings: { ...settings, lodLevels: levels, keepPercent: keep }
            },
            buildMetaName
        };
    }

    args.push(input);
    pushGeneratorParams(args, input, options);
    // LCC / LCC2 / streamed-SOG (lod-meta.json) input: which LOD levels to read (--select-lod n,n,...), a per-input action
    if (/\.lcc2?$|lod-meta\.json$/i.test(input) && options.lodSelect != null && options.lodSelect !== '') {
        const sel = String(options.lodSelect).trim();
        if (!/^\d+(,\d+)*$/.test(sel)) throw new Error(`Invalid LOD select: ${sel} (use comma-separated levels like 0,1,2)`);
        args.push('--select-lod', sel);
    }
    // Edit panel (viewport-driven): uniform scale (-s) and translate (-t). Distinct
    // from the Convert-panel transforms handled by pushConvertActions below; a given
    // request sets one path or the other.
    if (options.transform) {
        const t = options.transform;
        if (t.scale != null && t.scale !== '' && Number(t.scale) !== 1) {
            args.push('-s', String(num(t.scale, 1, 1e-4, 1e5)));
        }
        if (t.translate != null && t.translate !== '') {
            const v = String(t.translate).trim();
            if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:,-?(?:\d+(?:\.\d+)?|\.\d+)){2}$/.test(v)) throw new Error(`Invalid translate: ${v} (use x,y,z)`);
            args.push('-t', v);
        }
    }
    // Convert-panel transforms/filters + filterNaN + decimate + morton-order
    pushConvertActions(args, options);
    // WebP image render: camera + projection + DoF + motion blur, before output
    if (format === 'webp') {
        const img = options.image ?? {};
        const equirect = img.projection === 'equirect';
        if (equirect) args.push('--projection', 'equirect');
        args.push('--camera-pos', csv(img.camera ?? '2,1,-2', 'camera', 3));
        args.push('--camera-target', csv(img.lookAt ?? '0,0,0', 'look-at', 3));
        args.push('--camera-up', csv(img.up ?? '0,1,0', 'up', 3));
        if (!equirect && img.fov) args.push('--camera-fov', String(num(img.fov, 60, 1, 179)));
        if (img.resolution) {
            const r = String(img.resolution).trim().toLowerCase();
            if (!/^\d{2,5}x\d{2,5}$/.test(r)) throw new Error(`Invalid resolution: ${r} (use WxH like 1920x1080)`);
            args.push('--resolution', r);
        }
        if (img.near) args.push('--camera-near', String(num(img.near, 0.2, 0.0001, 1000)));
        if (img.background) args.push('--background', csv(img.background, 'background', 3));
        if (!equirect && img.fStop) { // depth of field (pinhole only)
            args.push('--f-stop', String(num(img.fStop, 2.8, 0.5, 64)));
            if (img.focusDistance) args.push('--focus-distance', String(num(img.focusDistance, 1, 0.001, 10000)));
            if (img.sensorSize) args.push('--sensor-size', String(num(img.sensorSize, 0.024, 0.0001, 1000)));
        }
        if (img.cameraEnd) { // camera motion blur
            args.push('--camera-pos-end', csv(img.cameraEnd, 'camera-end', 3));
            if (img.lookAtEnd) args.push('--camera-target-end', csv(img.lookAtEnd, 'look-at-end', 3));
            if (img.upEnd) args.push('--camera-up-end', csv(img.upEnd, 'up-end', 3));
            if (img.shutter != null && img.shutter !== '') args.push('--shutter', String(num(img.shutter, 1, 0, 1)));
            if (img.motionSamples) args.push('--motion-samples', String(Math.round(num(img.motionSamples, 16, 1, 256))));
        }
    }
    args.push(output);

    return {
        title: `Convert ${input} → ${output}`,
        args,
        expectedOutputs: [output],
        viewables: viewableOutputs([output])
    };
};

// Build the voxelize + collision-mesh argv for one job.
export const buildCollisionCommand = ({ input, options = {} }) => {
    // Fixed canonical name (not derived from the source LOD) so a project always
    // has one collision set at a known path for the tour runtime to pick up:
    // collision.voxel.json / collision.voxel.bin / collision.collision.glb.
    // Regenerating overwrites it (-w), which is the intent.
    const base = 'collision';
    const voxelOut = `${base}.voxel.json`;
    const collisionOut = `${base}.collision.glb`;

    const args = [cliPath, '--no-tty', '-w'];
    args.push(input);

    if (options.filterCluster) args.push('--filter-cluster');
    if (Array.isArray(options.seedPos) && options.seedPos.length === 3) {
        args.push('--seed-pos', options.seedPos.map((v) => num(v, 0, -1e6, 1e6)).join(','));
    }
    // crop the working set to the collision region before voxelization (-B/-S are
    // per-input actions, so they sit before the output token)
    pushCropFilters(args, options);

    args.push(voxelOut);
    // voxel size and opacity are separate scalar flags
    args.push('--voxel-size', String(num(options.voxelSize, 0.05, 0.001, 10)));
    args.push('--voxel-opacity', String(num(options.opacity, 0.1, 0, 1)));
    if (options.fillMode === 'external') {
        args.push('--voxel-external-fill', String(num(options.fillSize, 1.6, 0, 100)));
    } else if (options.fillMode === 'floor') {
        args.push('--voxel-floor-fill', String(num(options.fillSize, 1.6, 0, 100)));
    }
    if (options.carve) {
        args.push('--voxel-carve', `${num(options.carveHeight, 1.6, 0.01, 100)},${num(options.carveRadius, 0.2, 0.01, 100)}`);
    }
    args.push('--collision-mesh', options.meshShape === 'faces' ? 'faces' : 'smooth');

    return {
        title: `Collision for ${input}`,
        args,
        expectedOutputs: [voxelOut, `${base}.voxel.bin`, collisionOut],
        viewables: [{ name: collisionOut, as: 'collision' }]
    };
};

// Analysis-only: print file info + per-column statistics (--stats) with a `null`
// output so no file is written. -q drops the progress chrome, leaving a clean stats
// table in the job log. For a .mjs generator input, params shape the scene first.
export const buildSummaryCommand = ({ input, options = {} }) => {
    const args = [cliPath, '--no-tty', '-q', input];
    pushGeneratorParams(args, input, options);
    args.push('--stats', 'text', 'null'); // --stats prints file info + per-column table; null output writes nothing
    return {
        title: `Summary of ${input}`,
        args,
        expectedOutputs: [], // analysis-only — stats live in the job log
        viewables: []
    };
};

// which viewer layer (if any) can display this file — the single name → layer
// mapping (the file listing and job viewables both use it)
export const viewableAs = (name) => {
    if (name.endsWith('.collision.glb')) return 'collision';
    if (name.endsWith('.voxel.json')) return 'voxel';
    if (/\.ply$/i.test(name) || name.endsWith('.sog') || name.endsWith('meta.json')) return 'splat';
    return null;
};

// job outputs → viewable descriptors for the ones the viewer can load
const viewableOutputs = (names) => names
    .map((name) => { const as = viewableAs(name); return as ? { name, as } : null; })
    .filter(Boolean);

// Remove (or keep) the gaussians inside a box/sphere region, writing a trimmed
// .ply. Runs the Node trim worker. The region is in the same frame the GUI
// box/sphere fields use (what -B/-S consume). Any single-file splat works: PLY is
// trimmed directly; other formats (.sog/.spz/.splat/.ksplat/.lcc) are decompressed
// to a temp PLY via the CLI first, then trimmed — so the output is always .ply.
export const buildTrimCommand = ({ input, options = {}, workspaceDir }) => {
    if (/(^|\/)(lod-)?meta\.json$/i.test(input) || !/\.(ply|sog|spz|splat|ksplat|lcc2?)$/i.test(input)) {
        throw new Error('Trim works on single-file splats (.ply/.sog/.spz/.splat/.ksplat/.lcc) — not bundle folders');
    }
    const mode = options.mode === 'keep' ? 'keep' : 'remove';
    const box = Array.isArray(options.box) ? options.box : null;
    const sphere = Array.isArray(options.sphere) ? options.sphere : null;
    if (box) {
        if (box.length !== 6) throw new Error('trim box needs 6 values (min x,y,z, max x,y,z)');
        if (box.every((s) => String(s ?? '').trim() === '' || String(s).trim() === '-')) {
            throw new Error('trim box: set at least one bound');
        }
    }
    if (sphere) {
        if (sphere.length !== 4) throw new Error('trim sphere needs 4 values (x, y, z, radius)');
        if (!(Number(sphere[3]) >= 0)) throw new Error('trim sphere: radius must be >= 0');
    }
    if (!box && !sphere) throw new Error('Trim needs a box or sphere region');

    const base = baseName(input);
    let output = `${base}-trimmed.ply`;
    if (outputCollides(output, input, workspaceDir)) output = `${base}-trimmed-2.ply`;

    const shapes = `${box ? 'box' : ''}${box && sphere ? '+' : ''}${sphere ? 'sphere' : ''}`;
    return {
        title: `Trim ${input} → ${output} (${mode} inside ${shapes})`,
        command: `ply-trim ${input} → ${output} [${mode} inside ${shapes}]`,
        args: [trimWorkerPath, JSON.stringify({ src: input, out: output, mode, box, sphere })],
        expectedOutputs: [output],
        viewables: viewableOutputs([output])
    };
};
