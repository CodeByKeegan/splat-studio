export type ViewKind = 'splat' | 'collision' | 'voxel';

export interface FileEntry {
    name: string;
    size: number;
    mtime: number;
    kind: 'splat' | 'lod' | 'voxel' | 'collision' | 'glb' | 'export' | 'other';
    viewable: ViewKind | null;
}

export interface Viewable {
    name: string;
    as: ViewKind;
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

export interface ConvertRequest {
    input: string;
    format: string;
    options: {
        iterations?: number;
        spzVersion?: number;
        decimate?: string;
        filterNaN?: boolean;
        device?: 'auto' | 'cpu';
        // transform/filter actions applied to the working set before writing
        // (not applied to LOD bakes). translate/rotate are [x,y,z]; scale a factor.
        translate?: [number, number, number];
        rotate?: [number, number, number];
        scale?: number;
        filterHarmonics?: string; // '' | '0' | '1' | '2' | '3'
        lodLevels?: number;
        lodKeepPercent?: number;
        lodChunkCount?: number;
        lodChunkExtent?: number;
        /** combine mode: files for LOD 1..n (the main input is LOD 0) */
        lodFiles?: string[];
    };
}

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
