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
    'html': (base) => `${base}.html`
};

export const convertFormats = Object.keys(OUTPUT_NAMES);

const vec3Arg = (v, name) => {
    if (!Array.isArray(v) || v.length !== 3) throw new Error(`${name} needs 3 numbers`);
    return v.map((x) => {
        const n = Number(x);
        if (!Number.isFinite(n)) throw new Error(`${name}: invalid number "${x}"`);
        return n;
    });
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
        if (!Number.isFinite(s)) throw new Error(`Invalid scale value: ${options.scale}`);
        args.push('-s', String(s));
    }

    if (options.filterHarmonics != null && options.filterHarmonics !== '') {
        const h = Number(options.filterHarmonics);
        if (![0, 1, 2, 3].includes(h)) throw new Error(`Invalid filter-harmonics value: ${options.filterHarmonics} (must be 0-3)`);
        args.push('-H', String(h));
    }

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

    const fv = options.filterValue;
    if (fv && typeof fv === 'object') {
        const col = String(fv.column ?? '').trim();
        if (!/^[A-Za-z0-9_]+$/.test(col)) throw new Error(`filter-value: invalid column name "${fv.column}"`);
        if (!['lt', 'lte', 'gt', 'gte', 'eq', 'neq'].includes(fv.comparator)) {
            throw new Error(`filter-value: invalid comparator "${fv.comparator}"`);
        }
        const val = Number(fv.value);
        if (!Number.isFinite(val)) throw new Error(`filter-value: invalid value "${fv.value}"`);
        args.push('-V', `${col},${fv.comparator},${val}`);
    }

    const ff = options.filterFloaters;
    if (ff && typeof ff === 'object') {
        const has = (x) => x != null && String(x).trim() !== '';
        if (!has(ff.size) && !has(ff.opacity) && !has(ff.min)) {
            args.push('-G'); // bare flag → CLI defaults (0.05, 0.1, 0.004)
        } else {
            const size = num(has(ff.size) ? ff.size : 0.05, 0.05, 0, 1e6);
            const op = num(has(ff.opacity) ? ff.opacity : 0.1, 0.1, 0, 1);
            const min = num(has(ff.min) ? ff.min : 0.004, 0.004, 0, 1);
            args.push('-G', `${size},${op},${min}`);
        }
    }

    if (options.decimate != null && options.decimate !== '') {
        const d = String(options.decimate).trim();
        if (!/^\d+%?$/.test(d)) throw new Error(`Invalid decimate value: ${d} (use a count or percentage like 50%)`);
        args.push('-F', d);
    }

    if (options.mortonOrder) args.push('-M'); // reorder last, after geometry is final
};

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
    if (options.device === 'cpu') args.push('-g', 'cpu');
    if (format === 'sog' || format === 'sog-unbundled' || format === 'html' || format === 'lod') {
        args.push('-i', String(Math.round(num(options.iterations, 10, 1, 100))));
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
    pushConvertActions(args, options);
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

export const viewableOutputs = (names) => names
    .map((name) => {
        if (name.endsWith('.collision.glb')) return { name, as: 'collision' };
        if (name.endsWith('.ply') || name.endsWith('.sog') || name.endsWith('meta.json')) return { name, as: 'splat' };
        return null;
    })
    .filter(Boolean);
