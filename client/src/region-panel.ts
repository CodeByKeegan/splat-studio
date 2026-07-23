// Collision-region controls: the viewport region box/sphere synced with the
// Collision panel's fields, plus the marching-cubes overflow risk estimate.
import { $ } from './dom';
import { viewer } from './state';
import { showToast, fmtCount, numOrNull } from './ui';
import { round } from './line-meshes';
import { rebuildSceneList } from './viewport';
import { afterViewFileHooks } from './files-panel';
import { syncActionRows } from './convert-panel';

// region-pair row toggles first, so this listener order (row-toggle -> seeding
// -> estimate) matches the pre-split registration order
for (const cb of ['region-box-on', 'region-sphere-on']) $(cb).addEventListener('change', syncActionRows);

export const regMinX = $<HTMLInputElement>('region-min-x'), regMinY = $<HTMLInputElement>('region-min-y'), regMinZ = $<HTMLInputElement>('region-min-z');
export const regMaxX = $<HTMLInputElement>('region-max-x'), regMaxY = $<HTMLInputElement>('region-max-y'), regMaxZ = $<HTMLInputElement>('region-max-z');
export const regSphX = $<HTMLInputElement>('region-sphere-x'), regSphY = $<HTMLInputElement>('region-sphere-y'), regSphZ = $<HTMLInputElement>('region-sphere-z'), regSphR = $<HTMLInputElement>('region-sphere-r');
export const regionBoxOn = (): boolean => $<HTMLInputElement>('region-box-on').checked;
export const regionSphereOn = (): boolean => $<HTMLInputElement>('region-sphere-on').checked;
export const regionShadeEl = $<HTMLInputElement>('region-shade');

export const syncRegionViz = (): void => {
    $('region-shade-row').classList.toggle('hidden', !regionBoxOn() && !regionSphereOn());
    if (!viewer) return;
    viewer.setCollisionRegion(
        [numOrNull(regMinX), numOrNull(regMinY), numOrNull(regMinZ)],
        [numOrNull(regMaxX), numOrNull(regMaxY), numOrNull(regMaxZ)],
        regionBoxOn()
    );
    viewer.setCollisionSphere(
        [Number(regSphX.value), Number(regSphY.value), Number(regSphZ.value)],
        Number(regSphR.value),
        regionSphereOn()
    );
    rebuildSceneList(); // the region items appear/disappear with their toggles
};
afterViewFileHooks.push(syncRegionViz); // re-fit the region when a splat loads

// first time it's switched on, fill the box with the whole-scene bounds so the user shrinks inward
const seedRegionDefaults = () => {
    const empty = [regMinX, regMinY, regMinZ, regMaxX, regMaxY, regMaxZ].every((el) => el.value.trim() === '');
    if (!empty) return;
    const b = viewer?.regionDefaultBounds();
    if (!b) return;
    regMinX.value = String(b.min[0]); regMinY.value = String(b.min[1]); regMinZ.value = String(b.min[2]);
    regMaxX.value = String(b.max[0]); regMaxY.value = String(b.max[1]); regMaxZ.value = String(b.max[2]);
};

// first time on, centre the sphere in the scene at half its widest extent
const seedSphereDefaults = () => {
    const untouched = Number(regSphX.value) === 0 && Number(regSphY.value) === 0 && Number(regSphZ.value) === 0 && Number(regSphR.value) === 1;
    if (!untouched) return;
    const b = viewer?.regionDefaultBounds();
    if (!b) return;
    regSphX.value = String(round((b.min[0] + b.max[0]) / 2));
    regSphY.value = String(round((b.min[1] + b.max[1]) / 2));
    regSphZ.value = String(round((b.min[2] + b.max[2]) / 2));
    regSphR.value = String(round(Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1) / 2));
};

for (const el of [regMinX, regMinY, regMinZ, regMaxX, regMaxY, regMaxZ, regSphX, regSphY, regSphZ, regSphR]) el.addEventListener('input', syncRegionViz);
$('region-box-on').addEventListener('change', () => {
    if (regionBoxOn()) seedRegionDefaults();
    syncRegionViz();
    if (regionBoxOn()) viewer?.selectObject('collision-region'); // raise the gizmo + handles immediately
    updateRegionEstimate();
});
$('region-sphere-on').addEventListener('change', () => {
    if (regionSphereOn()) seedSphereDefaults();
    syncRegionViz();
    if (regionSphereOn()) viewer?.selectObject('collision-sphere');
    updateRegionEstimate();
});
regionShadeEl.addEventListener('input', () => viewer?.setRegionFaceOpacity(Number(regionShadeEl.value)));

// ---------- overflow estimate (advisory) ----------
// splat-transform's marching-cubes vertex dedup Map overflows V8's hard cap.
const MC_VERTEX_CAP = 16_777_216;
// risk proxy: in-box gaussians scaled by (0.05/voxelSize)^2 (finer voxels => more MC vertices).
// calibrated against the known failure — the whole 12.2M-gaussian Acropolis at 0.05 m overflowed.
let regionRiskLevel: 'ok' | 'warn' | 'danger' = 'ok';
const regionVoxelSize = () => Math.max(Number($<HTMLInputElement>('voxel-size').value) || 0.05, 0.001);
export const updateRegionEstimate = (): void => {
    const chip = $('region-estimate'), actions = $('region-estimate-actions');
    if (!viewer || !viewer.hasSplat || (!regionBoxOn() && !regionSphereOn())) { regionRiskLevel = 'ok'; chip.classList.add('hidden'); actions.classList.add('hidden'); return; }
    const inBox = viewer.regionGaussianCount();
    const vs = regionVoxelSize();
    const load = inBox * Math.pow(0.05 / vs, 2);
    regionRiskLevel = load >= 11_000_000 ? 'danger' : load >= 6_000_000 ? 'warn' : 'ok';
    chip.classList.remove('hidden', 'warn', 'danger');
    if (regionRiskLevel === 'ok') {
        chip.textContent = `Region: ~${fmtCount(inBox)} gaussians at ${vs} m — overflow risk low.`;
        actions.classList.add('hidden');
    } else {
        chip.classList.add(regionRiskLevel);
        chip.textContent = `Region: ~${fmtCount(inBox)} gaussians at ${vs} m — ${regionRiskLevel === 'danger' ? 'high' : 'elevated'} risk of the marching-cubes vertex limit (cap ${fmtCount(MC_VERTEX_CAP)}). Shrink the region or raise the voxel size.`;
        actions.classList.remove('hidden');
    }
};
afterViewFileHooks.push(updateRegionEstimate);
export const getRegionRiskLevel = (): 'ok' | 'warn' | 'danger' => regionRiskLevel;
let regionEstTimer = 0;
const updateRegionEstimateDebounced = () => { clearTimeout(regionEstTimer); regionEstTimer = window.setTimeout(updateRegionEstimate, 200); };
for (const el of [regMinX, regMinY, regMinZ, regMaxX, regMaxY, regMaxZ, regSphX, regSphY, regSphZ, regSphR]) el.addEventListener('input', updateRegionEstimateDebounced);
$('voxel-size').addEventListener('input', updateRegionEstimateDebounced);

$('region-coarsen').onclick = () => {
    if (!viewer) return;
    const inBox = viewer.regionGaussianCount();
    const needed = 0.05 * Math.sqrt(Math.max(inBox, 1) / 5_000_000); // aim ~5M load
    const vsEl = $<HTMLInputElement>('voxel-size');
    const next = Math.max(Math.ceil(needed / 0.005) * 0.005, regionVoxelSize() + 0.005);
    vsEl.value = String(Math.round(next * 1000) / 1000);
    vsEl.dispatchEvent(new Event('input', { bubbles: true }));
    vsEl.dispatchEvent(new Event('change', { bubbles: true }));
    updateRegionEstimate();
    showToast(`Voxel size raised to ${vsEl.value} m`);
};
$('region-shrink-seed').onclick = () => {
    const sx = Number($<HTMLInputElement>('seed-x').value) || 0, sy = Number($<HTMLInputElement>('seed-y').value) || 0, sz = Number($<HTMLInputElement>('seed-z').value) || 0;
    const r = 6; // 12 m cube around the seed
    regMinX.value = String(sx - r); regMinY.value = String(sy - r); regMinZ.value = String(sz - r);
    regMaxX.value = String(sx + r); regMaxY.value = String(sy + r); regMaxZ.value = String(sz + r);
    for (const el of [regMinX, regMinY, regMinZ, regMaxX, regMaxY, regMaxZ]) el.dispatchEvent(new Event('change', { bubbles: true }));
    syncRegionViz();
    updateRegionEstimate();
    showToast('Region shrunk to a 12 m box around the seed');
};
