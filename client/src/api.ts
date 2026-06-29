export type ViewKind = 'splat' | 'collision' | 'voxel';

export interface FileEntry {
    name: string;
    size: number;
    mtime: number;
    kind: 'splat' | 'lod' | 'voxel' | 'collision' | 'glb' | 'export' | 'generator' | 'other';
    viewable: ViewKind | null;
}

export interface Viewable {
    name: string;
    as: ViewKind;
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
    status: 'running' | 'done' | 'error';
    command: string;
    log: string;
    outputs: string[];
    viewables: Viewable[];
    startedAt: number;
    endedAt: number | null;
}

/** WebP render camera/projection/DoF/motion-blur (CLI image-output options). */
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

const jsonOrThrow = async (res: Response) => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    return body;
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
    await jsonOrThrow(await fetch('/api/layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(layout)
    }));
};

/** GPU adapters (-L/--list-gpus) for the device dropdown. */
export const listGpus = async (): Promise<Gpu[]> =>
    (await jsonOrThrow(await fetch('/api/gpus'))).gpus;

/** Component versions for the Settings/About section (PlayCanvas comes from the bundled engine). */
export interface Versions { app: string | null; splatTransform: string | null; }
export const getVersions = async (): Promise<Versions> =>
    jsonOrThrow(await fetch('/api/versions'));

export const createProject = async (name: string): Promise<void> => {
    await jsonOrThrow(await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    }));
};

export const listFiles = async (): Promise<FileEntry[]> =>
    (await jsonOrThrow(await fetch(`/api/files?${pq()}`))).files;

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
    (await jsonOrThrow(await fetch('/api/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req, project })
    }))).jobId;

export const startCollision = async (req: CollisionRequest): Promise<string> =>
    (await jsonOrThrow(await fetch('/api/collision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req, project })
    }))).jobId;

/** Analysis-only run: per-column stats (-m) to the job log, no file written. */
export const startAnalyze = async (input: string): Promise<string> =>
    (await jsonOrThrow(await fetch('/api/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, project })
    }))).jobId;

/** A .mjs generator's advertised param schema, or null if it exposes none. */
export const getGeneratorParams = async (input: string): Promise<GenParam[] | null> =>
    (await jsonOrThrow(await fetch(`/api/generator-params?${pq()}&input=${encodeURIComponent(input)}`))).params;

export const getJob = async (id: string): Promise<Job> =>
    jsonOrThrow(await fetch(`/api/jobs/${id}`));

export const cancelJob = async (id: string): Promise<void> => {
    await jsonOrThrow(await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' }));
};

/** Polls until the job leaves 'running'; onUpdate fires on every poll. */
export const watchJob = async (id: string, onUpdate: (job: Job) => void): Promise<Job> => {
    for (;;) {
        const job = await getJob(id);
        onUpdate(job);
        if (job.status !== 'running') return job;
        await new Promise((r) => setTimeout(r, 700));
    }
};

// project is a path prefix (not a query) so the engine can fetch bundle
// siblings — LOD chunks, unbundled-SOG textures — by relative URL
export const fileUrl = (name: string): string =>
    `/files/${[project, ...name.split('/')].map(encodeURIComponent).join('/')}`;
