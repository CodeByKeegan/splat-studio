// Shared mutable app state + late-bound cross-layer hooks. Single writers use
// the setters; readers import the live bindings. Hooks break import cycles:
// lower-layer modules call them, their owners assign them at eval/boot.
import type { SplatViewer } from './viewer';
import type * as api from './api';

export let viewer: SplatViewer | undefined;
export const setViewer = (v: SplatViewer): void => { viewer = v; };

// per-layer visibility, toggled by the Scene panel's eye buttons
export const layerVisible = { splat: true, collision: true, voxels: true };
export type LayerId = keyof typeof layerVisible;

// name of the file loaded into each viewer layer (null = none)
export let currentSplatName: string | null = null;
export let currentCollisionName: string | null = null;
export let currentVoxelName: string | null = null;
export const setCurrentSplatName = (n: string | null): void => { currentSplatName = n; };
export const setCurrentCollisionName = (n: string | null): void => { currentCollisionName = n; };
export const setCurrentVoxelName = (n: string | null): void => { currentVoxelName = n; };

// splat-kind file names from the last listing (feeds the input selects)
export let splatFileNames: string[] = [];
export const setSplatFileNames = (names: string[]): void => { splatFileNames = names; };

// build-meta.json per LOD bundle, keyed name@mtime; null = none on disk (404)
export const lodMetaCache = new Map<string, api.LodBuildMeta | null>();

// late-bound cross-layer callbacks (assigned by undo.ts / main.ts)
export const hooks: { scheduleUndoCapture: () => void; syncEditorStatus: () => void } = {
    scheduleUndoCapture: () => {},
    syncEditorStatus: () => {}
};
