// Headless CONVERT / GENERATE tools (not consent-gated). Each STARTS a job and
// returns {jobId} immediately — poll with jobs(action="wait"). Output names are
// server-decided; resolved paths appear in the job's outputs on completion.
import { z } from 'zod';
import { apiPost, apiGet, qs } from '../http.mjs';
import { headless, SAFE } from './_wrap.mjs';

// marching-cubes vertex cap (V8 Map limit 2^24) the collision preflight guards against
const MC_VERTEX_CAP = 16_777_216;

// ---- shared schema pieces ----
const vec3 = z.array(z.number()).length(3);
const device = z
    .union([z.enum(['cpu', 'auto']), z.number().int().min(0).max(64)])
    .describe('GPU device: "auto" (default, omits -g) | "cpu" | adapter index 0-64. SOG has a CPU fallback.');

const filterBox = z
    .array(z.union([z.number(), z.literal(''), z.literal('-')]))
    .length(6)
    .describe('[minX,minY,minZ,maxX,maxY,maxZ] in the SPLAT frame (viewer [x,y,z] -> [x,-y,-z]); "" or "-" leaves a side unbounded; set at least one bound.');
const filterSphere = z.array(z.number()).length(4).describe('[x,y,z,radius] in the SPLAT frame; radius >= 0.');

const filterValue = z
    .object({
        column: z.string().regex(/^[A-Za-z0-9_]+$/),
        comparator: z.enum(['lt', 'lte', 'gt', 'gte', 'eq', 'neq']),
        value: z.number()
    })
    .describe('Keep gaussians where <column> <comparator> <value>. For column "opacity" the value must be strictly in (0,1).');

const filterFloaters = z
    .object({
        size: z.number().positive().optional(),
        opacity: z.number().min(0).max(1).optional(),
        min: z.number().min(0).optional()
    })
    .describe('GPU-only floater removal (-G). Empty {} = CLI defaults (0.05,0.1,0.004). With device "cpu" the server rejects it up front (bad-input); with no usable GPU the job fails as gpu-required.');

export function register(server) {
    server.registerTool('convert', {
        title: 'Convert',
        description:
            'Convert a splat to another format with optional transforms / filters / crop / decimate. Returns {jobId} (fire-and-poll). Use build_lod for streamed LOD and render_image for a WebP render. translate/rotate and filterBox/filterSphere are the SPLAT frame (viewer [x,y,z] -> [x,-y,-z]).',
        annotations: SAFE,
        inputSchema: {
            project: z.string(),
            input: z.string().describe('Project-relative source path (or a .mjs generator).'),
            format: z.enum(['ply', 'compressed-ply', 'sog', 'sog-unbundled', 'spz', 'glb', 'csv', 'html']),
            device: device.optional(),
            iterations: z.number().int().min(1).max(100).optional().describe('SOG SH-compression iterations (sog/sog-unbundled/html), default 10.'),
            maxWorkers: z.number().int().min(0).max(64).optional().describe('SOG encoder worker threads (default 4; 0 = inline).'),
            spzVersion: z.union([z.literal(3), z.literal(4)]).optional().describe('SPZ version (default 4).'),
            scale: z.number().positive().optional().describe('Uniform scale -s (> 0).'),
            translate: vec3.optional().describe('Translate -t [x,y,z] (CLI space).'),
            rotate: vec3.optional().describe('Rotate -r [x,y,z] Euler degrees.'),
            filterHarmonics: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional().describe('Strip SH above band N (-H).'),
            filterValue: filterValue.optional(),
            filterFloaters: filterFloaters.optional(),
            filterBox: filterBox.optional(),
            filterSphere: filterSphere.optional(),
            filterNaN: z.boolean().optional().describe('Drop NaN/Inf gaussians (-N).'),
            decimate: z.string().regex(/^\d+%?$/).optional().describe('Decimate to a count or percentage like "50%" (-F).'),
            scratchDir: z.string().optional().describe('Absolute path to an existing directory for decimation spill files (--scratch-dir); may be off-workspace (another volume). Only used with decimate; omitted/blank = alongside the output.'),
            mortonOrder: z.boolean().optional().describe('Morton-reorder (-M).'),
            verbose: z.boolean().optional(),
            params: z.string().regex(/^[A-Za-z0-9_]+=[^,=]+(,[A-Za-z0-9_]+=[^,=]+)*$/).optional().describe('Generator params key=val,key=val (.mjs inputs only).'),
            lodSelect: z.string().regex(/^\d+(,\d+)*$/).optional().describe('LCC LOD select -O (.lcc/.lcc2 inputs).'),
            unbundled: z.boolean().optional().describe('HTML viewer: unbundled output (-U).'),
            viewerSettings: z.string().optional().describe('HTML viewer: viewer-settings json path (-E).')
        }
    }, headless(async ({ project, input, format, ...options }) => await apiPost('/api/convert', { project, input, format, options })));

    server.registerTool('build_lod', {
        title: 'Build streamed LOD',
        description:
            'Bake a streamed multi-LOD SOG (lod-meta.json + per-LOD chunk folders). mode="decimate" auto-decimates one input into lodLevels; mode="combine" uses lodFiles as explicit lighter levels, optionally tagging one as an always-visible environment shell (env flag). Also writes build-meta.json inside the bundle — the reproducible recipe (source per level, env selection, effective settings, per-level gaussian counts); read it back with inspect(target="lod_recipe"). Returns {jobId}.',
        annotations: SAFE,
        inputSchema: {
            project: z.string(),
            input: z.string().describe('LOD 0 (highest detail) source.'),
            mode: z.enum(['decimate', 'combine']),
            lodLevels: z.number().int().min(1).max(8).optional().describe('decimate: number of levels incl. LOD 0 (default 3).'),
            lodKeepPercent: z.number().min(5).max(95).optional().describe('decimate: percent kept per level (default 50).'),
            scratchDir: z.string().optional().describe('decimate: absolute path to an existing directory for decimation spill files (--scratch-dir); may be off-workspace. Omitted/blank = alongside each temp output.'),
            lodFiles: z.array(z.string()).optional().describe('combine: additional level files in detail order (each lighter than the last).'),
            lodEnvFlags: z.array(z.boolean()).optional().describe('combine: per lodFiles entry, true = always-visible backdrop (LOD -1). Needs >=1 non-env level.'),
            lodChunkCount: z.number().int().min(16).max(8192).optional().describe('approx gaussians per chunk in K (-C, default 512).'),
            lodChunkExtent: z.number().int().min(1).max(1000).optional().describe('approx chunk size in meters (-X, default 16).'),
            iterations: z.number().int().min(1).max(100).optional(),
            maxWorkers: z.number().int().min(0).max(64).optional(),
            device: device.optional()
        }
    }, headless(async ({ project, input, mode, lodFiles, lodEnvFlags, ...rest }) => {
        // the server infers mode from lodFiles presence: non-empty => combine, else decimate
        const options = { ...rest };
        if (mode === 'combine') {
            if (!Array.isArray(lodFiles) || lodFiles.length === 0) throw new Error('combine mode needs at least one entry in lodFiles');
            options.lodFiles = lodFiles;
            if (lodEnvFlags) options.lodEnvFlags = lodEnvFlags;
        }
        return await apiPost('/api/convert', { project, input, format: 'lod', options });
    }));

    server.registerTool('render_image', {
        title: 'Render image (WebP)',
        description:
            'Offline WebP render of a splat via the GPU rasterizer (camera / projection / depth-of-field / motion blur). Returns {jobId}. Camera vectors (camera/lookAt/up + the *End motion-blur vectors) are SPLAT-frame "x,y,z" strings (viewer [x,y,z] -> [x,-y,-z]; render_pose reads/sets the same pose).',
        annotations: SAFE,
        inputSchema: {
            project: z.string(),
            input: z.string(),
            device: device.optional(),
            image: z
                .object({
                    projection: z.enum(['perspective', 'equirect']).optional().describe('default perspective. equirect REJECTS fov/fStop/focusDistance/sensorSize (omit them) and requires a 2:1 resolution (width = 2 × height; default 2048x1024).'),
                    camera: z.string().optional().describe('eye "x,y,z" (CLI space; default "2,1,-2").'),
                    lookAt: z.string().optional().describe('target "x,y,z" (default "0,0,0").'),
                    up: z.string().optional().describe('up "x,y,z" (default "0,1,0").'),
                    fov: z.number().min(1).max(179).optional().describe('field of view (perspective only, default 60).'),
                    resolution: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional().describe('"WxH" e.g. 1920x1080.'),
                    near: z.number().min(0.0001).max(1000).optional(),
                    background: z.string().optional().describe('"r,g,b".'),
                    fStop: z.number().min(0.5).max(64).optional().describe('DoF aperture (pinhole only, default 2.8).'),
                    focusDistance: z.number().min(0.001).max(10000).optional(),
                    sensorSize: z.number().min(0.0001).max(1000).optional(),
                    cameraEnd: z.string().optional().describe('motion-blur end eye "x,y,z" (enables motion blur).'),
                    lookAtEnd: z.string().optional(),
                    upEnd: z.string().optional(),
                    shutter: z.number().min(0).max(1).optional(),
                    motionSamples: z.number().int().min(1).max(256).optional()
                })
                .optional()
        }
    }, headless(async ({ project, input, device: dev, image }) => {
        const img = image ?? {};
        if (img.projection === 'equirect') {
            // enforce what the description promises: no pinhole-only params, 2:1 resolution
            for (const k of ['fov', 'fStop', 'focusDistance', 'sensorSize']) {
                if (img[k] != null) throw new Error(`equirect rejects ${k} — omit it`);
            }
            const r = img.resolution ?? '2048x1024';
            const [w, h] = r.split('x').map(Number);
            if (w !== 2 * h) throw new Error(`equirect needs a 2:1 resolution (width = 2 × height), got ${r}`);
        }
        return await apiPost('/api/convert', { project, input, format: 'webp', options: { device: dev, image: img } });
    }));

    server.registerTool('generate_collision', {
        title: 'Generate collision',
        description:
            'Voxelize a splat into a collision mesh (collision.collision.glb + voxel json/bin). GPU required (no device param); an unavailable GPU returns gpu-required. seedPos is VOXEL space (viewer [x,y,z] -> [-x,y,-z]); the crop region (filterBox/filterSphere) is the SPLAT frame (viewer -> [x,-y,-z]), same as convert/trim. Returns {jobId}.',
        annotations: SAFE,
        inputSchema: {
            project: z.string(),
            input: z.string(),
            voxelSize: z.number().min(0.001).max(10).optional().describe('voxel size (default 0.05). Smaller = finer + heavier (V8 Map cap risk on huge scenes).'),
            opacity: z.number().min(0).max(1).optional().describe('voxel opacity threshold (default 0.1).'),
            fillMode: z.enum(['external', 'floor']).optional().describe('optional solid fill: external shell or floor.'),
            fillSize: z.number().min(0).max(100).optional().describe('fill size (default 1.6).'),
            carve: z.object({ height: z.number().min(0.01).max(100), radius: z.number().min(0.01).max(100) }).optional().describe('carve a player tunnel (--voxel-carve height,radius).'),
            meshShape: z.enum(['smooth', 'faces']).optional().describe('-K mesh style (default smooth).'),
            seedPos: vec3.optional().describe('--seed-pos [x,y,z] in VOXEL space (viewer [x,y,z] -> [-x,y,-z]; Y-up, 1m above floor = [0,1,0]).'),
            filterCluster: z.boolean().optional().describe('--filter-cluster (GPU; can TDR on very large scans).'),
            filterBox: filterBox.optional().describe('crop the collision region to a box before voxelizing (SPLAT frame, same as convert/trim).'),
            filterSphere: filterSphere.optional(),
            overridePreflight: z.boolean().optional().describe('proceed even if the V8-Map size preflight estimates a crash risk (default false).')
        }
    }, headless(async ({ project, input, carve, overridePreflight, voxelSize, ...rest }) => {
        const options = { ...rest };
        if (voxelSize != null) options.voxelSize = voxelSize;
        if (carve) { options.carve = true; options.carveHeight = carve.height; options.carveRadius = carve.radius; }
        // V8-Map preflight: estimate the marching-cubes vertex load before voxelizing.
        // load = gaussians * (0.05/voxelSize)^2, calibrated to the 12.2M-at-0.05 failure.
        // Refuse only the clear case (whole splat, fine voxel); a region crops the load
        // unpredictably, so report the (conservative) risk but don't block it.
        const vs = Math.max(Number(voxelSize ?? 0.05), 0.001);
        const hasRegion = Array.isArray(options.filterBox) || Array.isArray(options.filterSphere);
        let preflight = null;
        try {
            const { count } = await apiGet(`/api/stats${qs({ project, input })}`);
            if (Number.isFinite(count)) {
                const load = Math.round(count * Math.pow(0.05 / vs, 2));
                const riskLevel = load >= 11_000_000 ? 'danger' : load >= 6_000_000 ? 'warn' : 'ok';
                preflight = { gaussianCount: count, voxelSize: vs, regionSet: hasRegion, estimatedVertexLoad: load, vertexCap: MC_VERTEX_CAP, riskLevel };
                if (riskLevel === 'danger' && !hasRegion && overridePreflight !== true) {
                    return {
                        refused: true,
                        preflight,
                        message: `Voxelizing all ~${count.toLocaleString()} gaussians at ${vs} m would likely overflow splat-transform's marching-cubes vertex limit (RangeError: Map maximum size exceeded). Raise voxelSize, crop with filterBox/filterSphere, or pass overridePreflight:true to run anyway.`
                    };
                }
            }
        } catch { /* stats unavailable — proceed without a preflight */ }
        const job = await apiPost('/api/collision', { project, input, options });
        return preflight ? { ...job, preflight } : job;
    }));

    server.registerTool('trim_region', {
        title: 'Trim region (carve / crop)',
        description:
            'Remove (carve) or keep-only (crop) the gaussians inside a box and/or sphere, writing a new trimmed .ply. Works on any single-file splat (.ply/.sog/.spz/.splat/.ksplat/.lcc; non-PLY are decompressed first). box/sphere are the SPLAT frame (viewer [x,y,z] -> [x,-y,-z]). Returns {jobId}.',
        annotations: SAFE,
        inputSchema: {
            project: z.string(),
            input: z.string().describe('Single-file splat (not a meta.json/lod-meta.json bundle).'),
            mode: z.enum(['remove', 'keep']).optional().describe('remove = carve inside (default); keep = crop to inside.'),
            box: filterBox.optional().describe('box region (>=1 bound); CLI space.'),
            sphere: filterSphere.optional().describe('sphere region; CLI space.')
        }
    }, headless(async ({ project, input, mode, box, sphere }) => {
        if (!box && !sphere) throw new Error('trim_region needs a box and/or sphere region');
        return await apiPost('/api/trim', { project, input, options: { mode: mode ?? 'remove', box, sphere } });
    }));
}
