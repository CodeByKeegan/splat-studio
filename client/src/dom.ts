// Throw-fast DOM handles shared across panel modules: the $ lookup plus every
// element referenced by more than one module.
export const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
};

export const fileList = $<HTMLUListElement>('file-list');
export const convertInput = $<HTMLSelectElement>('convert-input');
export const genInput = $<HTMLSelectElement>('gen-input');
export const lodInput = $<HTMLSelectElement>('lod-input');
export const renderInput = $<HTMLSelectElement>('render-input');
export const collisionInput = $<HTMLSelectElement>('collision-input');
export const analyzeInput = $<HTMLSelectElement>('analyze-input');
export const editInput = $<HTMLSelectElement>('edit-input');
export const skyboxSelect = $<HTMLSelectElement>('skybox-select');
export const hudSplat = $<HTMLSpanElement>('hud-splat');
export const hudCollision = $<HTMLSpanElement>('hud-collision');
export const hudVoxel = $<HTMLSpanElement>('hud-voxel');
export const jobCommand = $<HTMLElement>('job-command');
export const jobLog = $<HTMLPreElement>('job-log');
export const convertRun = $<HTMLButtonElement>('convert-run');
export const lodRun = $<HTMLButtonElement>('lod-run');
export const renderRun = $<HTMLButtonElement>('render-run');
export const collisionRun = $<HTMLButtonElement>('collision-run');
export const analyzeRun = $<HTMLButtonElement>('analyze-run');
export const convertFormat = $<HTMLSelectElement>('convert-format');
export const generateViewBtn = $<HTMLButtonElement>('generate-view');
export const carveBox = $<HTMLInputElement>('carve');
export const projectSelect = $<HTMLSelectElement>('project-select');
