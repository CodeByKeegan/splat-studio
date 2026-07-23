// Edit panel: live transform/crop preview in the viewport, the region apply
// (carve/crop -> trimmed .ply), and the measure/origin tools.
import * as api from './api';
import { $, editInput } from './dom';
import { viewer, currentSplatName } from './state';
import { showToast, numOrNull } from './ui';
import { panelActive } from './dockview';
import { viewportCallbacks } from './viewport';
import { runJob } from './jobs';
import { afterViewFileHooks } from './files-panel';

// ----- live viewport preview (Edit transforms + region fields) -----
const tfX = $<HTMLInputElement>('tf-translate-x'), tfY = $<HTMLInputElement>('tf-translate-y'), tfZ = $<HTMLInputElement>('tf-translate-z');
const rfX = $<HTMLInputElement>('tf-rotate-x'), rfY = $<HTMLInputElement>('tf-rotate-y'), rfZ = $<HTMLInputElement>('tf-rotate-z');
const tfScaleEl = $<HTMLInputElement>('tf-scale');

const ecBoxMinX = $<HTMLInputElement>('carve-box-min-x'), ecBoxMinY = $<HTMLInputElement>('carve-box-min-y'), ecBoxMinZ = $<HTMLInputElement>('carve-box-min-z');
const ecBoxMaxX = $<HTMLInputElement>('carve-box-max-x'), ecBoxMaxY = $<HTMLInputElement>('carve-box-max-y'), ecBoxMaxZ = $<HTMLInputElement>('carve-box-max-z');
const ecSphX = $<HTMLInputElement>('carve-sphere-x'), ecSphY = $<HTMLInputElement>('carve-sphere-y'), ecSphZ = $<HTMLInputElement>('carve-sphere-z'), ecSphR = $<HTMLInputElement>('carve-sphere-r');
const ecBoxOn = () => $<HTMLInputElement>('carve-box-on').checked;
const ecSphOn = () => $<HTMLInputElement>('carve-sphere-on').checked;
const previewingEdit = () => currentSplatName !== null && currentSplatName === editInput.value;

// the transform preview shows only while the EDIT input splat is the displayed one,
// so baked outputs aren't double-transformed
const syncSplatXform = () => {
    if (!viewer) return;
    if (!previewingEdit()) { viewer.setSplatPreviewTransform(null, [0, 0, 0], 1); return; }
    viewer.setSplatPreviewTransform(
        [Number(tfX.value), Number(tfY.value), Number(tfZ.value)],
        [Number(rfX.value), Number(rfY.value), Number(rfZ.value)],
        Number(tfScaleEl.value)
    );
};

// The viewport region box/sphere belongs to the Edit panel (crop / carve). It's live
// only while the Edit tab is shown, the Edit input splat is displayed, and a region is on.
type CropOwner = 'edit' | 'none';
const cropOwner = (): CropOwner =>
    panelActive('panel-edit') && previewingEdit() && (ecBoxOn() || ecSphOn()) ? 'edit' : 'none';
export const ownerBoxFields = (): HTMLInputElement[] => [ecBoxMinX, ecBoxMinY, ecBoxMinZ, ecBoxMaxX, ecBoxMaxY, ecBoxMaxZ];
export const ownerSphFields = (): HTMLInputElement[] => [ecSphX, ecSphY, ecSphZ, ecSphR];

export const syncCropViz = (): void => {
    if (!viewer) return;
    if (cropOwner() === 'edit') {
        viewer.setCropBox([numOrNull(ecBoxMinX), numOrNull(ecBoxMinY), numOrNull(ecBoxMinZ)], [numOrNull(ecBoxMaxX), numOrNull(ecBoxMaxY), numOrNull(ecBoxMaxZ)], ecBoxOn());
        viewer.setCropSphere([Number(ecSphX.value), Number(ecSphY.value), Number(ecSphZ.value)], Number(ecSphR.value), ecSphOn());
    } else {
        viewer.setCropBox([null, null, null], [null, null, null], false);
        viewer.setCropSphere([0, 0, 0], 0, false);
    }
    updateCarveCountDebounced();
};

export const syncPreview = (): void => { syncSplatXform(); syncCropViz(); };
viewportCallbacks.syncPreview = syncPreview;
afterViewFileHooks.push(syncPreview); // re-sync when a splat loads into the viewer

for (const el of [tfX, tfY, tfZ, rfX, rfY, rfZ, tfScaleEl]) el.addEventListener('input', syncSplatXform);
for (const el of [ecBoxMinX, ecBoxMinY, ecBoxMinZ, ecBoxMaxX, ecBoxMaxY, ecBoxMaxZ, ecSphX, ecSphY, ecSphZ, ecSphR]) el.addEventListener('input', syncCropViz);
for (const id of ['carve-box-on', 'carve-sphere-on']) $(id).addEventListener('change', syncCropViz);
editInput.addEventListener('change', syncPreview);
// reveal each carve region's fields only when its checkbox is on
for (const [cb, rows] of [['carve-box-on', 'carve-box-rows'], ['carve-sphere-on', 'carve-sphere-rows']] as const) {
    $(cb).addEventListener('change', () => $(rows).classList.toggle('hidden', !$<HTMLInputElement>(cb).checked));
}

// ----- apply a region (Edit panel) → a trimmed .ply -----
// remove (carve) deletes inside; keep (crop) deletes outside. The CLI's -B/-S only
// KEEP inside, so both run a local Node trim (server/ply-trim.mjs) that supports either mode.
const carveRemoveBtn = $<HTMLButtonElement>('carve-remove');
const carveCount = $<HTMLDivElement>('carve-count');
const regionModeEl = $<HTMLSelectElement>('region-mode');
export const regionMode = (): 'remove' | 'keep' => regionModeEl.value === 'keep' ? 'keep' : 'remove';
export const carveRegion = (): { box?: string[]; sphere?: [number, number, number, number] } | null => {
    const box = ecBoxOn() ? [ecBoxMinX.value, ecBoxMinY.value, ecBoxMinZ.value, ecBoxMaxX.value, ecBoxMaxY.value, ecBoxMaxZ.value] : undefined;
    const sphere = ecSphOn() ? [Number(ecSphX.value), Number(ecSphY.value), Number(ecSphZ.value), Number(ecSphR.value)] as [number, number, number, number] : undefined;
    return box || sphere ? { box, sphere } : null;
};
export const syncCarveBtn = (): void => { carveRemoveBtn.disabled = !carveRegion(); };
function updateCarveCount(): void {
    if (!viewer || cropOwner() !== 'edit') { carveCount.classList.add('hidden'); return; }
    const n = viewer.trimInsideCount(); // gaussians inside the region
    const total = viewer.splatGaussianCount;
    const pct = total ? ` (${Math.round(100 * n / total)}%)` : '';
    carveCount.textContent = regionMode() === 'keep'
        ? `Crop keeps ~${n.toLocaleString()} gaussians inside the region${pct}.`
        : `Carve removes ~${n.toLocaleString()} gaussians inside the region${pct}.`;
    carveCount.classList.remove('hidden');
}
let carveCountTimer = 0;
function updateCarveCountDebounced(): void { clearTimeout(carveCountTimer); carveCountTimer = window.setTimeout(updateCarveCount, 150); }
for (const id of ['carve-box-on', 'carve-sphere-on']) $(id).addEventListener('change', () => syncCarveBtn());
regionModeEl.addEventListener('change', () => { syncCarveBtn(); updateCarveCount(); });
syncCarveBtn();
carveRemoveBtn.onclick = () => {
    const input = editInput.value;
    if (!input) return showToast('Pick a splat to edit first', true);
    const region = carveRegion();
    if (!region) return showToast('Enable a Box or Sphere region first', true);
    const mode = regionMode();
    const ask = mode === 'keep'
        ? `Keep only the gaussians inside the region from ${input} (crop)? This writes a new trimmed .ply — the source is left untouched.`
        : `Remove the gaussians inside the region from ${input} (carve)? This writes a new trimmed .ply — the source is left untouched.`;
    if (!confirm(ask)) return;
    void runJob(() => api.startTrim({ input, options: { mode, ...region } }), carveRemoveBtn);
};

// the Edit-panel transform fields (-t/-r/-s), fanned by the Apply transform button
// and the linked-group apply (so a group edit replays the same transform on each member)
export const editTransformOptions = () => ({
    translate: [Number(tfX.value), Number(tfY.value), Number(tfZ.value)] as [number, number, number],
    rotate: [Number(rfX.value), Number(rfY.value), Number(rfZ.value)] as [number, number, number],
    scale: Number(tfScaleEl.value)
});

// ----- measure → scale, set origin -----
export const measureToggle = $<HTMLInputElement>('measure-toggle');
export const originToggle = $<HTMLInputElement>('origin-toggle');
const measureReadout = $<HTMLSpanElement>('measure-readout');
const editAbtn = $<HTMLButtonElement>('measure-edit-a');
const editBbtn = $<HTMLButtonElement>('measure-edit-b');

let nextMarker: 'a' | 'b' = 'a';
export const reflectActiveMarker = (which: 'a' | 'b'): void => {
    nextMarker = which;
    editAbtn.classList.toggle('active', which === 'a');
    editBbtn.classList.toggle('active', which === 'b');
};

export const updateMeasureReadout = (d?: number): void => {
    if (!viewer) return;
    if (originToggle.checked) {
        measureReadout.textContent = viewer.markersPlaced
            ? 'Origin point set — click again to move it, then Set as origin.'
            : 'Click the splat where the new origin should be.';
        return;
    }
    if (measureToggle.checked && !viewer.markersPlaced) {
        measureReadout.textContent = `Click the splat to place point ${nextMarker.toUpperCase()}.`;
        return;
    }
    const dist = d ?? viewer.measureDistance();
    const len = Number($<HTMLInputElement>('measure-length').value);
    measureReadout.textContent = len > 0 && dist > 0
        ? `A–B = ${dist.toFixed(3)} m → scale ×${(len / dist).toFixed(4)}`
        : `A–B = ${dist.toFixed(3)} m`;
};

// switch the Edit panel's viewport tool; exclusive, toggling off the other
const setEditTool = (mode: 'none' | 'measure' | 'origin'): void => {
    measureToggle.checked = mode === 'measure';
    originToggle.checked = mode === 'origin';
    $('measure-edit-row').classList.toggle('hidden', mode !== 'measure');
    reflectActiveMarker('a');
    viewer?.setEditMode(mode);
    if (mode === 'measure') measureReadout.textContent = 'Click the splat to place point A.';
    else if (mode === 'origin') measureReadout.textContent = 'Click the splat where the new origin should be.';
    else measureReadout.textContent = 'Enable a tool, then click the splat to place points.';
};
measureToggle.onchange = () => setEditTool(measureToggle.checked ? 'measure' : 'none');
originToggle.onchange = () => setEditTool(originToggle.checked ? 'origin' : 'none');
$<HTMLInputElement>('measure-length').oninput = () => updateMeasureReadout();

const setActiveMarker = (which: 'a' | 'b'): void => {
    viewer?.setActiveMarker(which);
    reflectActiveMarker(which);
    updateMeasureReadout();
};
editAbtn.onclick = () => setActiveMarker('a');
editBbtn.onclick = () => setActiveMarker('b');

const applyTransformBtn = $<HTMLButtonElement>('apply-transform');
applyTransformBtn.onclick = () => {
    const input = editInput.value;
    if (!input) return showToast('Pick a splat to edit', true);
    const { translate, rotate, scale } = editTransformOptions();
    const noop = translate.every((v) => v === 0) && rotate.every((v) => v === 0) && scale === 1;
    if (noop) return showToast('Set a non-zero translate / rotate or a scale ≠ 1 first', true);
    void runJob(() => api.startConvert({ input, format: 'ply', options: { translate, rotate, scale } }), applyTransformBtn);
};

$<HTMLButtonElement>('apply-scale').onclick = () => {
    const input = editInput.value;
    if (!input) return showToast('Pick a splat to edit', true);
    if (!viewer || !measureToggle.checked || !viewer.markersPlaced) return showToast('Click the splat to place points A and B first', true);
    const dist = viewer.measureDistance();
    const len = Number($<HTMLInputElement>('measure-length').value);
    if (!(dist > 0)) return showToast('Points A and B are at the same spot', true);
    if (!(len > 0)) return showToast('Enter the real A–B length', true);
    void runJob(() => api.startConvert({ input, format: 'ply', options: { transform: { scale: len / dist } } }), $<HTMLButtonElement>('apply-scale'));
};

$<HTMLButtonElement>('apply-origin').onclick = () => {
    const input = editInput.value;
    if (!input) return showToast('Pick a splat to edit', true);
    if (!viewer || !originToggle.checked || !viewer.markersPlaced) return showToast('Click the splat to place the origin point first', true);
    const t = viewer.originTranslateCli();
    void runJob(() => api.startConvert({ input, format: 'ply', options: { transform: { translate: `${t.x},${t.y},${t.z}` } } }), $<HTMLButtonElement>('apply-origin'));
};
