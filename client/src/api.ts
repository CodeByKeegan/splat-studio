// Typed client for the whole loopback HTTP API: request/response shapes plus
// thin fetch wrappers, job submission, and the watch-until-terminal poller.
export type ViewKind = 'splat' | 'collision' | 'voxel';

export interface FileEntry {
    name: string;
    size: number;
    mtime: number;
    kind: 'splat' | 'lod' | 'voxel' | 'collision' | 'glb' | 'export' | 'generator' | 'other';
    viewable: ViewKind | null;
    /** gaussian count from a cheap header/metadata read; absent when unknown */
    gaussians?: number;
    /** kind 'lod' only: per-LOD-level gaussian counts */
    lodCounts?: number[];
}

export interface Viewable {
    name: string;
    as: ViewKind;
}

/** One level of an LOD bundle's build recipe (environment shell = level -1). */
export interface LodBuildLevel {
    level: number;
    source: string;
    gaussians?: number;
    keepPercent?: number;
    environment?: boolean;
}

/** <lodDir>/build-meta.json — the recipe a streamed-LOD bundle was baked from. */
export interface LodBuildMeta {
    version: number;
    createdAt: string;
    generator: { app: string | null; splatTransform: string | null };
    mode: 'combine' | 'decimate';
    input: string;
    levels: LodBuildLevel[];
    settings: {
        iterations?: number;
        maxWorkers?: number;
        device?: string | number;
        chunkCount?: number;
        chunkExtent?: number;
        filterNaN?: boolean;
        lodLevels?: number;
        keepPercent?: number;
    };
}

/** A live slider a .mjs generator advertises via its static `Generator.params`. */
export interface GenParam {
    name: string;
    label?: string;
    min?: number;
    max?: number;
    step?: number;
    default?: number;
}

export interface Job {
    id: string;
    title: string;
    status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
    command: string;
    log: string;
    outputs: string[];
    viewables: Viewable[];
    queuedAt: number;
    startedAt: number | null;
    endedAt: number | null;
}

/** /api/jobs list entry — a Job without its log. */
export type JobSummary = Omit<Job, 'log'>;

/** Still waiting or working — the complement of the terminal done/error/cancelled states. */
export const isJobActive = (job: { status: Job['status'] }): boolean =>
    job.status === 'queued' || job.status === 'running';

/** WebP render camera/projection/DoF/motion-blur (CLI image-output options).
 *  Mirrors the full server surface — some fields (up, near, sensorSize,
 *  lookAtEnd, upEnd) are exercised via MCP render_image rather than the GUI. */
export interface ImageOptions {
    camera?: string;        // "x,y,z"
    lookAt?: string;        // "x,y,z"
    up?: string;            // "x,y,z"
    fov?: number;
    resolution?: string;    // "WxH"
    near?: number;
    background?: string;    // "r,g,b" in 0..1
    projection?: 'pinhole' | 'equirect';
    fStop?: number;         // DoF (pinhole only)
    focusDistance?: number;
    sensorSize?: number;
    cameraEnd?: string;     // motion blur
    lookAtEnd?: string;
    upEnd?: string;
    shutter?: number;
    motionSamples?: number;
}

export interface ConvertRequest {
    input: string;
    format: string;
    options: {
        iterations?: number;
        /** SOG encoder worker threads (--max-workers); 0 = inline/serial */
        maxWorkers?: number;
        spzVersion?: number;
        decimate?: string;
        /** absolute dir for decimation spill files (--scratch-dir); blank = alongside the output */
        scratchDir?: string;
        filterNaN?: boolean;
        /** 'auto' | 'cpu' | a GPU adapter index (string) */
        device?: string;
        verbose?: boolean;
        /** HTML output: separate files (-U) + a viewer-settings.json (-E) */
        unbundled?: boolean;
        viewerSettings?: string;
        /** LCC input: comma-separated LOD levels to read (-O) */
        lodSelect?: string;
        // Convert-panel transform/filter actions applied to the working set before
        // writing (not applied to LOD bakes). translate/rotate are [x,y,z].
        translate?: [number, number, number];
        rotate?: [number, number, number];
        scale?: number;
        filterHarmonics?: string; // '' | '0' | '1' | '2' | '3'
        filterBox?: string[]; // 6 raw values [minX,minY,minZ,maxX,maxY,maxZ]; blank = unbounded
        filterSphere?: [number, number, number, number]; // [x,y,z,radius]
        filterValue?: { column: string; comparator: string; value: number };
        filterFloaters?: { size: string; opacity: string; min: string }; // GPU; blank = defaults
        mortonOrder?: boolean;
        lodLevels?: number;
        lodKeepPercent?: number;
        lodChunkCount?: number;
        lodChunkExtent?: number;
        /** combine mode: files for LOD 1..n (the main input is LOD 0) */
        lodFiles?: string[];
        /** combine mode: per-file flag aligned 1:1 with lodFiles; true tags that file -l -1 (always-resident environment level) */
        lodEnvFlags?: boolean[];
        /** .mjs generator params, raw "key=val,key=val" forwarded to -p/--params */
        params?: string;
        /** WebP render options */
        image?: ImageOptions;
        /** viewport-driven edit: uniform scale (-s) and/or translate "x,y,z" (-t) */
        transform?: { scale?: number; translate?: string };
    };
}

export interface Gpu { index: number; name: string; }

export interface CollisionRequest {
    input: string;
    options: {
        voxelSize: number;
        opacity: number;
        filterCluster: boolean;
        seedPos: [number, number, number];
        fillMode: 'none' | 'external' | 'floor';
        fillSize: number;
        carve: boolean;
        carveHeight: number;
        carveRadius: number;
        meshShape: 'smooth' | 'faces';
        // collision region: crop the splat before voxelization (same axes/space as seedPos)
        filterBox?: string[]; // 6 raw values [minX,minY,minZ,maxX,maxY,maxZ]; blank = unbounded
        filterSphere?: [number, number, number, number]; // [x,y,z,radius]
    };
}

// parse a JSON response, throwing the server's {error} message on non-2xx.
// Trusts the declared return type of each wrapper — no runtime validation.
const jsonOrThrow = async (res: Response) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    return body;
};

// POST a JSON body and parse the JSON response via jsonOrThrow
const postJson = async (url: string, body: unknown) =>
    jsonOrThrow(await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }));

/** MCP editor binding + per-workspace consent, from /api/editor/status. */
export interface EditorStatus {
    connected: boolean;
    editorProject: string | null;
    appVersion: string | null;
    lastSeenMs: number | null;
    port: number;
    controlEnabled: boolean;
}

export const getEditorStatus = async (): Promise<EditorStatus> =>
    jsonOrThrow(await fetch('/api/editor/status'));

export const setEditorControl = async (enabled: boolean): Promise<void> => {
    await postJson('/api/editor/control', { enabled });
};

// the active project scopes every file/job call; set by the UI on project switch
let project = '';
export const setProject = (name: string): void => { project = name; };
export const getProject = (): string => project;
const pq = () => `project=${encodeURIComponent(project)}`;

export const listProjects = async (): Promise<string[]> =>
    (await jsonOrThrow(await fetch('/api/projects'))).projects;

/** The workspace-wide UI layout blob (dockable-editor arrangement). Not project-scoped. */
export type Layout = Record<string, unknown>;
export const getLayout = async (): Promise<Layout> =>
    jsonOrThrow(await fetch('/api/layout'));
export const saveLayout = async (layout: Layout): Promise<void> => {
    await postJson('/api/layout', layout);
};

/** A location group: source splats that are the same place at different detail. Project-scoped. */
export interface LocationGroup { members: string[]; proxy: string | null; }
export const getGroup = async (): Promise<LocationGroup> =>
    jsonOrThrow(await fetch(`/api/groups?${pq()}`));
export const saveGroup = async (group: LocationGroup): Promise<void> => {
    await postJson(`/api/groups?${pq()}`, group);
};

/** GPU adapters (-L/--list-gpus) for the device dropdown. */
export const listGpus = async (): Promise<Gpu[]> =>
    (await jsonOrThrow(await fetch('/api/gpus'))).gpus;

/** Component versions for the Settings/About section (PlayCanvas comes from the bundled engine). */
export interface Versions { app: string | null; splatTransform: string | null; }
export const getVersions = async (): Promise<Versions> =>
    jsonOrThrow(await fetch('/api/versions'));

/** The workspace folder whose subfolders are projects. */
export interface Workspace { path: string; projects: string[]; }
export const getWorkspace = async (): Promise<Workspace> =>
    jsonOrThrow(await fetch('/api/workspace'));

/** Re-point the app at a different workspace folder (live, no restart). */
export const setWorkspace = async (path: string, create = false): Promise<Workspace> =>
    postJson('/api/workspace', { path, create });

export const createProject = async (name: string): Promise<void> => {
    await postJson('/api/projects', { name });
};

export const listFiles = async (): Promise<FileEntry[]> => {
    const body = await jsonOrThrow(await fetch(`/api/files?${pq()}`));
    // spot-check the shape: server drift should fail here, not as downstream undefineds
    if (!Array.isArray(body.files)) throw new Error('Malformed /api/files response');
    return body.files;
};

/** XHR instead of fetch so large uploads (30–270 MB splats) report progress. */
export const uploadFile = (file: File, onProgress?: (pct: number) => void): Promise<void> =>
    new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/upload?${pq()}&name=${encodeURIComponent(file.name)}`);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) return resolve();
            let message = `${xhr.status} ${xhr.statusText}`;
            try { message = JSON.parse(xhr.responseText).error ?? message; } catch { /* keep status text */ }
            reject(new Error(message));
        };
        xhr.onerror = () => reject(new Error('network error during upload'));
        xhr.send(file);
    });

export const deleteFile = async (name: string): Promise<void> => {
    await jsonOrThrow(await fetch(`/api/files/${name.split('/').map(encodeURIComponent).join('/')}?${pq()}`, { method: 'DELETE' }));
};

export const startConvert = async (req: ConvertRequest): Promise<string> =>
    (await postJson('/api/convert', { ...req, project })).jobId;

export const startCollision = async (req: CollisionRequest): Promise<string> =>
    (await postJson('/api/collision', { ...req, project })).jobId;

/** Carve out (remove) or keep the gaussians inside a box/sphere region → a trimmed .ply. */
export interface TrimRequest {
    input: string;
    options: {
        mode: 'remove' | 'keep';
        box?: string[];                               // 6 raw values [minX,minY,minZ,maxX,maxY,maxZ]; blank = unbounded
        sphere?: [number, number, number, number];    // [x,y,z,radius]
    };
}
export const startTrim = async (req: TrimRequest): Promise<string> =>
    (await postJson('/api/trim', { ...req, project })).jobId;

/** Analysis-only run: per-column stats (-m) to the job log, no file written. */
export const startAnalyze = async (input: string): Promise<string> =>
    (await postJson('/api/summary', { input, project })).jobId;

/** Gaussian count + x/y/z extents for a splat (cached server-side); drives LOD auto-tune. */
export interface FileStats { count: number; extents: [number, number, number]; }
export const getStats = async (input: string): Promise<FileStats> =>
    jsonOrThrow(await fetch(`/api/stats?${pq()}&input=${encodeURIComponent(input)}`));

/** A .mjs generator's advertised param schema, or null if it exposes none. */
export const getGeneratorParams = async (input: string): Promise<GenParam[] | null> =>
    (await jsonOrThrow(await fetch(`/api/generator-params?${pq()}&input=${encodeURIComponent(input)}`))).params;

export const getJob = async (id: string): Promise<Job> => {
    const job = await jsonOrThrow(await fetch(`/api/jobs/${id}`));
    if (typeof job?.id !== 'string' || typeof job?.status !== 'string') throw new Error('Malformed job response');
    return job;
};

/** All jobs (queued/running/finished, no logs) + the current concurrency cap. */
export const getJobs = async (): Promise<{ jobs: JobSummary[]; concurrency: number }> =>
    jsonOrThrow(await fetch('/api/jobs'));

/** How many jobs may run at once (the rest queue FIFO); returns the clamped value. */
export const setJobConcurrency = async (max: number): Promise<number> =>
    (await postJson('/api/jobs/concurrency', { max })).concurrency;

export const cancelJob = async (id: string): Promise<void> => {
    await jsonOrThrow(await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' }));
};

// project is a path prefix (not a query) so the engine can fetch bundle
// siblings — LOD chunks, unbundled-SOG textures — by relative URL
export const fileUrl = (name: string): string =>
    `/files/${[project, ...name.split('/')].map(encodeURIComponent).join('/')}`;
