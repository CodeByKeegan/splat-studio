// Collision panel: presets, seed + carve capsule gizmo sync, knob visibility,
// and the collision-generation run.
import * as api from './api';
import { $, collisionInput, carveBox } from './dom';
import { viewer } from './state';
import { showToast, panelValid } from './ui';
import { rebuildSceneList } from './viewport';
import { runJob } from './jobs';
import { regionBoxOn, regionSphereOn, getRegionRiskLevel, regMinX, regMinY, regMinZ, regMaxX, regMaxY, regMaxZ, regSphX, regSphY, regSphZ, regSphR } from './region-panel';

const collisionRun = $<HTMLButtonElement>('collision-run');
const preset = $<HTMLSelectElement>('collision-preset');
const fillMode = $<HTMLSelectElement>('fill-mode');
export const seedX = $<HTMLInputElement>('seed-x');
export const seedY = $<HTMLInputElement>('seed-y');
export const seedZ = $<HTMLInputElement>('seed-z');
const carveHeight = $<HTMLInputElement>('carve-height');
const carveRadius = $<HTMLInputElement>('carve-radius');

// keep the in-viewport seed marker + carve capsule in sync with the fields
export const syncSeedViz = (): void => {
    if (!viewer) return;
    viewer.setSeed(Number(seedX.value), Number(seedY.value), Number(seedZ.value));
    viewer.setCapsule(Number(carveHeight.value), Number(carveRadius.value));
};
for (const el of [seedX, seedY, seedZ, carveHeight, carveRadius]) {
    el.addEventListener('input', syncSeedViz);
}

interface Preset {
    fillMode: string;
    carve: boolean;
    filterCluster: boolean;
    fillSize: number;
    carveHeight: number;
    carveRadius: number;
}
const PRESETS: Record<string, Preset> = {
    indoor: { fillMode: 'external', carve: true, filterCluster: true, fillSize: 1.6, carveHeight: 1.6, carveRadius: 0.2 },
    outdoor: { fillMode: 'floor', carve: false, filterCluster: true, fillSize: 1.6, carveHeight: 1.6, carveRadius: 0.2 },
    object: { fillMode: 'none', carve: false, filterCluster: true, fillSize: 1.6, carveHeight: 1.6, carveRadius: 0.2 }
};

// hide knobs the job would ignore
export const syncCollisionRows = (): void => {
    $('carve-params').classList.toggle('hidden', !carveBox.checked);
    $('row-fill-size').classList.toggle('hidden', fillMode.value === 'none');
};

preset.onchange = () => {
    const p = PRESETS[preset.value];
    if (!p) return;
    fillMode.value = p.fillMode;
    carveBox.checked = p.carve;
    $<HTMLInputElement>('filter-cluster').checked = p.filterCluster;
    $<HTMLInputElement>('fill-size').value = String(p.fillSize);
    carveHeight.value = String(p.carveHeight);
    carveRadius.value = String(p.carveRadius);
    syncCollisionRows();
};

// editing any preset-owned control flips the label to Custom (the seed is
// scene-specific, not preset-owned, so it doesn't count)
for (const id of ['fill-mode', 'carve', 'filter-cluster', 'voxel-size', 'voxel-opacity', 'fill-size', 'carve-height', 'carve-radius', 'mesh-shape']) {
    $(id).addEventListener('input', () => { preset.value = 'custom'; });
}
carveBox.addEventListener('input', syncCollisionRows);
carveBox.addEventListener('change', () => rebuildSceneList()); // capsule item depends on carve
fillMode.addEventListener('input', syncCollisionRows);
syncCollisionRows();

$<HTMLButtonElement>('seed-from-camera').onclick = () => {
    if (!viewer) return showToast('Viewer is still starting up', true);
    const p = viewer.cameraSeedPos();
    seedX.value = String(p.x);
    seedY.value = String(p.y);
    seedZ.value = String(p.z);
    syncSeedViz();
    showToast(`Seed set from camera: ${p.x}, ${p.y}, ${p.z}`);
};

collisionRun.onclick = () => {
    const input = collisionInput.value;
    if (!input) return showToast('Pick an input file first', true);
    if (!panelValid('panel-collision')) return;
    if ((regionBoxOn() || regionSphereOn()) && getRegionRiskLevel() === 'danger' &&
        !confirm('This region may exceed splat-transform\'s marching-cubes vertex limit (RangeError: Map maximum size exceeded). Shrink the region or raise the voxel size to be safe. Generate anyway?')) return;
    void runJob(() => api.startCollision({
        input,
        options: {
            voxelSize: Number($<HTMLInputElement>('voxel-size').value),
            opacity: Number($<HTMLInputElement>('voxel-opacity').value),
            filterCluster: $<HTMLInputElement>('filter-cluster').checked,
            seedPos: [Number(seedX.value), Number(seedY.value), Number(seedZ.value)],
            fillMode: fillMode.value as 'none' | 'external' | 'floor',
            fillSize: Number($<HTMLInputElement>('fill-size').value),
            carve: carveBox.checked,
            carveHeight: Number(carveHeight.value),
            carveRadius: Number(carveRadius.value),
            meshShape: $<HTMLSelectElement>('mesh-shape').value as 'smooth' | 'faces',
            filterBox: regionBoxOn() ? [
                regMinX.value, regMinY.value, regMinZ.value,
                regMaxX.value, regMaxY.value, regMaxZ.value
            ] : undefined,
            filterSphere: regionSphereOn() ? [
                Number(regSphX.value), Number(regSphY.value), Number(regSphZ.value), Number(regSphR.value)
            ] : undefined
        }
    }), collisionRun, $<HTMLInputElement>('collision-autoload').checked);
};
