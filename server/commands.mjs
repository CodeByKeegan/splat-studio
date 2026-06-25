import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// outputs produced by jobs this session — overwriting these again is intended
const priorOutputs = new Set();
export const recordOutputs = (names) => names.forEach((n) => priorOutputs.add(n));

// The CLI handles WebGPU device creation (native Dawn bindings) itself, so we
// spawn it rather than driving the programmatic API.
export const cliPath = path.join(rootDir, 'node_modules', '@playcanvas', 'splat-transform', 'bin', 'cli.mjs');

const num = (value, fallback, min, max) => {
    const n = Number(value ?? fallback);
    if (!Number.isFinite(n)) throw new Error(`Invalid number: ${value}`);
    return Math.min(max, Math.max(min, n));
};

// "x,y,z" (or "r,g,b[,a]") validator — values pass straight to the CLI as args
const csv = (value, label, count) => {
    const s = String(value ?? '').trim();
    const parts = s.split(',');
    if (parts.length < count || parts.length > count + 1 || parts.some((p) => !/^-?\d*\.?\d+$/.test(p.trim()))) {
        throw new Error(`Invalid ${label}: ${value} (expected ${count} comma-separated numbers)`);
    }
    return s;
};

// Output base name, always at the PROJECT ROOT (subfolders like "RAW SOG/" are
// stripped so generated artifacts sit at the top of the project, not buried
// beside their source). 'RAW SOG/room.compressed.ply' -> 'room';
// 'room-sog/meta.json' -> 'room'; 'scene-lod/lod-meta.json' -> 'scene'.
export const baseName = (input) => {
    const file = input.split('/').pop();
    if (file === 'meta.json' || file === 'lod-meta.json') {
        const dir = input.split('/').slice(-2, -1)[0] ?? 'splat';
        return dir.replace(/-sog$/, '').replace(/-lod$/, '');
    }
    return file.replace(/\.compressed\.ply$/i, '').replace(/\.[^./]+$/, '');
};

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

export const convertFormats = Object.keys(OUTPUT_NAMES);

// CLI grammar: splat-transform [GLOBAL] input [ACTIONS] output [ACTIONS]
export const buildConvertCommand = ({ input, format, options = {}, workspaceDir }) => {
    const makeName = Object.hasOwn(OUTPUT_NAMES, format) ? OUTPUT_NAMES[format] : null;
    if (!makeName) throw new Error(`Unknown output format: ${format}`);

    const base = baseName(input);
    let output = makeName(base);
    // never clobber the input, and don't silently overwrite pre-existing files
    // that this app didn't produce (e.g. compressed.ply -> ply landing on the
    // original source); re-running the same conversion stays idempotent.
    const collides = (name) => name === input ||
        (workspaceDir && !priorOutputs.has(name) && existsSync(path.join(workspaceDir, ...name.split('/'))));
    if (collides(output)) output = makeName(`${base}-converted`);

    const args = [cliPath, '--no-tty', '-w'];
    if (options.verbose) args.push('--verbose', '--mem'); // diagnostics
    // device: 'cpu' | 'auto' | a GPU adapter index (from -L/--list-gpus)
    if (options.device === 'cpu') args.push('-g', 'cpu');
    else if (options.device != null && options.device !== '' && options.device !== 'auto') {
        args.push('-g', String(Math.round(num(options.device, 0, 0, 64))));
    }
    if (format === 'sog' || format === 'sog-unbundled' || format === 'html' || format === 'lod') {
        args.push('-i', String(Math.round(num(options.iterations, 10, 1, 100))));
    }
    if (format === 'html') {
        if (options.unbundled) args.push('-U'); // separate files instead of one .html
        if (options.viewerSettings) { // -E settings.json (project-relative)
            const vs = String(options.viewerSettings).trim();
            if (!/^[A-Za-z0-9()._ /-]+\.json$/i.test(vs) || vs.includes('..')) {
                throw new Error(`Invalid viewer-settings path: ${vs}`);
            }
            args.push('-E', vs);
        }
    }
    if (format === 'spz') {
        const v = Number(options.spzVersion ?? 4);
        if (v !== 3 && v !== 4) throw new Error(`Invalid SPZ version: ${options.spzVersion}`);
        args.push('--spz-version', String(v));
    }

    if (format === 'lod') {
        args.push('-C', String(Math.round(num(options.lodChunkCount, 512, 16, 8192))));
        // the CLI parses -X with parseInteger; fractional input must be rounded
        args.push('-X', String(Math.round(num(options.lodChunkExtent, 16, 1, 1000))));

        const lodFiles = Array.isArray(options.lodFiles) ? options.lodFiles.filter(Boolean) : [];
        // lodFiles present-but-empty means combine mode with no levels — reject
        // rather than silently falling through to decimate mode
        if (Array.isArray(options.lodFiles) && lodFiles.length === 0) {
            throw new Error('Combine mode requires at least one additional LOD level file');
        }
        if (lodFiles.length > 0) {
            // combine mode: pre-authored detail levels — input is LOD 0,
            // lodFiles are LOD 1..n, no decimation
            const chain = [input, ...lodFiles];
            chain.forEach((file, level) => {
                args.push(file);
                if (options.filterNaN) args.push('-N');
                args.push('-l', String(level));
            });
            args.push(output);
            return {
                title: `Streamed LOD (combine ${chain.length} files) → ${output}`,
                args,
                expectedOutputs: [output],
                viewables: viewableOutputs([output]),
                // chunk folder names vary with settings; clear stale ones on re-run
                cleanDirs: [output.split('/')[0]]
            };
        }

        // decimate mode: the input is read once per level, each instance
        // decimated to keep%^level of the original and tagged -l <n>
        const levels = Math.round(num(options.lodLevels, 3, 1, 8));
        const keep = num(options.lodKeepPercent, 50, 5, 95);
        for (let level = 0; level < levels; level++) {
            args.push(input);
            if (options.filterNaN) args.push('-N');
            if (level > 0) {
                const pct = Math.max(1, Math.round(((keep / 100) ** level) * 100));
                args.push('-F', `${pct}%`);
            }
            args.push('-l', String(level));
        }
        args.push(output);
        return {
            title: `Streamed LOD (${levels} levels) ${input} → ${output}`,
            args,
            expectedOutputs: [output],
            viewables: viewableOutputs([output]),
            cleanDirs: [output.split('/')[0]]
        };
    }

    args.push(input);
    // .mjs generator parameters (-p key=val,...); a per-input action, so it must
    // sit right after the input token. Only meaningful for generator inputs.
    if (/\.mjs$/i.test(input) && options.params != null && options.params !== '') {
        const p = String(options.params).trim();
        if (!/^[A-Za-z0-9_]+=[^,=]+(,[A-Za-z0-9_]+=[^,=]+)*$/.test(p)) {
            throw new Error(`Invalid generator params: ${p} (use key=val,key=val)`);
        }
        args.push('-p', p);
    }
    // LCC input: which LOD levels to read (-O n,n,...), a per-input action
    if (/\.lcc$/i.test(input) && options.lodSelect != null && options.lodSelect !== '') {
        const sel = String(options.lodSelect).trim();
        if (!/^\d+(,\d+)*$/.test(sel)) throw new Error(`Invalid LOD select: ${sel} (use comma-separated levels like 0,1,2)`);
        args.push('-O', sel);
    }
    // viewport-driven edit transforms: uniform scale (-s) and translate (-t)
    if (options.transform) {
        const t = options.transform;
        if (t.scale != null && t.scale !== '' && Number(t.scale) !== 1) {
            args.push('-s', String(num(t.scale, 1, 1e-4, 1e5)));
        }
        if (t.translate != null && t.translate !== '') {
            const v = String(t.translate).trim();
            if (!/^-?\d*\.?\d+(,-?\d*\.?\d+){2}$/.test(v)) throw new Error(`Invalid translate: ${v} (use x,y,z)`);
            args.push('-t', v);
        }
    }
    if (options.filterNaN) args.push('-N');
    if (options.decimate != null && options.decimate !== '') {
        const d = String(options.decimate).trim();
        if (!/^\d+%?$/.test(d)) throw new Error(`Invalid decimate value: ${d} (use a count or percentage like 50%)`);
        args.push('-F', d);
    }
    // WebP image render: camera + projection + DoF + motion blur, before output
    if (format === 'webp') {
        const img = options.image ?? {};
        const equirect = img.projection === 'equirect';
        if (equirect) args.push('--projection', 'equirect');
        args.push('--camera', csv(img.camera ?? '2,1,-2', 'camera', 3));
        args.push('--look-at', csv(img.lookAt ?? '0,0,0', 'look-at', 3));
        args.push('--up', csv(img.up ?? '0,1,0', 'up', 3));
        if (!equirect && img.fov) args.push('--fov', String(num(img.fov, 60, 1, 179)));
        if (img.resolution) {
            const r = String(img.resolution).trim().toLowerCase();
            if (!/^\d{2,5}x\d{2,5}$/.test(r)) throw new Error(`Invalid resolution: ${r} (use WxH like 1920x1080)`);
            args.push('--resolution', r);
        }
        if (img.near) args.push('--near', String(num(img.near, 0.2, 0.0001, 1000)));
        if (img.background) args.push('--background', csv(img.background, 'background', 3));
        if (!equirect && img.fStop) { // depth of field (pinhole only)
            args.push('--f-stop', String(num(img.fStop, 2.8, 0.5, 64)));
            if (img.focusDistance) args.push('--focus-distance', String(num(img.focusDistance, 1, 0.001, 10000)));
            if (img.sensorSize) args.push('--sensor-size', String(num(img.sensorSize, 0.024, 0.0001, 1000)));
        }
        if (img.cameraEnd) { // camera motion blur
            args.push('--camera-end', csv(img.cameraEnd, 'camera-end', 3));
            if (img.lookAtEnd) args.push('--look-at-end', csv(img.lookAtEnd, 'look-at-end', 3));
            if (img.upEnd) args.push('--up-end', csv(img.upEnd, 'up-end', 3));
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

    args.push(voxelOut);
    args.push('--voxel-params', `${num(options.voxelSize, 0.05, 0.001, 10)},${num(options.opacity, 0.1, 0, 1)}`);
    if (options.fillMode === 'external') {
        args.push('--voxel-external-fill', String(num(options.fillSize, 1.6, 0, 100)));
    } else if (options.fillMode === 'floor') {
        args.push('--voxel-floor-fill', String(num(options.fillSize, 1.6, 0, 100)));
    }
    if (options.carve) {
        args.push('--voxel-carve', `${num(options.carveHeight, 1.6, 0.01, 100)},${num(options.carveRadius, 0.2, 0.01, 100)}`);
    }
    args.push('-K', options.meshShape === 'faces' ? 'faces' : 'smooth');

    return {
        title: `Collision for ${input}`,
        args,
        expectedOutputs: [voxelOut, `${base}.voxel.bin`, collisionOut],
        viewables: [{ name: collisionOut, as: 'collision' }]
    };
};

// Analysis-only: print per-column statistics (-m) with a `null` output so no
// file is written. -q drops the progress chrome, leaving a clean Markdown stats
// table in the job log. For a .mjs generator input, params shape the scene first.
export const buildSummaryCommand = ({ input, options = {} }) => {
    const args = [cliPath, '--no-tty', '-q', input];
    if (/\.mjs$/i.test(input) && options.params != null && options.params !== '') {
        const p = String(options.params).trim();
        if (!/^[A-Za-z0-9_]+=[^,=]+(,[A-Za-z0-9_]+=[^,=]+)*$/.test(p)) {
            throw new Error(`Invalid generator params: ${p} (use key=val,key=val)`);
        }
        args.push('-p', p);
    }
    args.push('-m', 'null');
    return {
        title: `Summary of ${input}`,
        args,
        expectedOutputs: [], // analysis-only — stats live in the job log
        viewables: []
    };
};

export const viewableOutputs = (names) => names
    .map((name) => {
        if (name.endsWith('.collision.glb')) return { name, as: 'collision' };
        if (name.endsWith('.ply') || name.endsWith('.sog') || name.endsWith('meta.json')) return { name, as: 'splat' };
        return null;
    })
    .filter(Boolean);
