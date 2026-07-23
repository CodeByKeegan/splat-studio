// App shell: wires every panel (files, export, LOD, render, analyze, edit,
// collision, generate, jobs, settings) to the API and the 3D viewer, owns the
// dockable layout, app state, undo/redo, and the MCP editor-command handlers.
import './boot-theme'; // theme first — before any UI paints
import { $, fileList, convertInput, genInput, lodInput, renderInput, collisionInput, analyzeInput, editInput, collisionRun, analyzeRun, convertFormat, carveBox, projectSelect } from './dom';
import { viewer, setViewer, layerVisible, currentSplatName, splatFileNames, lodMetaCache, hooks } from './state';
import type { LayerId } from './state';
import { showToast, promptText, fmtSize, fmtCount, numOrNull } from './ui';
import { formState, FORM_KEY, EXTERNAL_STATE_IDS, restoreFormState } from './form-state';
import { dock, WINDOWS, winById, openWindow, closeWindow, applyDefaultLayout, reconcilePanelTitles, panelActive, getCameraViewCanvas, persistNow, makeMenu, bootLayout } from './dockview';
import { viewportCallbacks, toggleLayer, removeSplat, clearViewport, SCENE_ITEMS, rebuildSceneList, selectScene } from './viewport';
import { filesRefreshHooks, afterViewFileHooks, fileActionCallbacks, selectedFiles, fillSelect, refreshFiles, viewFile } from './files-panel';
import { panelValid, runJob, ensureJobsPolling } from './jobs';
import { updateGenRows } from './generate-panel';
import { updateConvertRows, updateInputRows, syncActionRows } from './convert-panel';
import { updateLodRows, baseLabel } from './lod-panel';
import { vecFieldIds, writeVecField, updateRenderFrustum } from './render-panel';
import * as api from './api';
import { SplatViewer } from './viewer';
import type { SelId } from './viewer';
import { startMcpBridge, editorError } from './mcp-bridge';
import { initThemeSettings } from './theme';
import type { DockviewApi } from 'dockview-core';

// ---------- upload ----------
const uploadFiles = async (files: Iterable<File>) => {
    let lastSplat: string | null = null;
    try {
        for (const file of files) {
            const li = document.createElement('li');
            li.className = 'uploading';
            const label = document.createElement('span');
            label.textContent = `Uploading ${file.name} (${fmtSize(file.size)})…`;
            const progress = document.createElement('div');
            progress.className = 'progress';
            const bar = document.createElement('div');
            progress.appendChild(bar);
            li.append(label, progress);
            fileList.prepend(li);
            try {
                await api.uploadFile(file, (pct) => { bar.style.width = `${pct}%`; });
            } finally {
                li.remove();
            }
            lastSplat = file.name;
        }
        showToast('Upload complete');
    } catch (err) {
        showToast(`Upload failed: ${err}`, true);
    } finally {
        // files before the failure did land; a refresh failure must not escape the
        // finally into the void-returning callers
        await refreshFiles().catch(() => showToast('Couldn\'t refresh the file list', true));
        // fresh upload becomes the active input — that's almost always the intent
        if (lastSplat && splatFileNames.includes(lastSplat)) {
            convertInput.value = lastSplat;
            lodInput.value = lastSplat;
            renderInput.value = lastSplat;
            collisionInput.value = lastSplat;
            analyzeInput.value = lastSplat;
        } else if (lastSplat && lastSplat.endsWith('.mjs')) {
            convertInput.value = lastSplat; // generators aren't collision sources
            analyzeInput.value = lastSplat;
            genInput.value = lastSplat;
        }
        updateInputRows();
        void updateGenRows();
    }
};

const fileInput = $<HTMLInputElement>('file-input');
$<HTMLButtonElement>('browse-btn').onclick = () => fileInput.click();
fileInput.onchange = () => {
    if (fileInput.files?.length) void uploadFiles(fileInput.files);
    fileInput.value = '';
};

// window-level drop: a missed drop must never navigate the app away
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types.includes('Files')) {
        dragDepth++;
        document.body.classList.add('dropping');
    }
});
window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
        dragDepth = 0;
        document.body.classList.remove('dropping');
    }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dropping');
    if (e.dataTransfer?.files.length) void uploadFiles(e.dataTransfer.files);
});

// A ready-to-run .mjs generator so the generator-input + params feature is
// usable without authoring one. Mirrors examples/gen-grid.mjs in the repo: a
// Generator class with static create(params) returning {count, columnNames,
// getRow}. Values are raw (log scale, logit opacity, SH-DC colour).
const SAMPLE_GENERATOR = `// Sample procedural splat generator for @playcanvas/splat-transform.
// Run it from Splat Studio's Generate tab with params like: width=16,height=16,scale=4
const SH_C0 = 0.28209479177387814;
const toSH = c => (c - 0.5) / SH_C0;        // colour [0..1] -> f_dc
const toLogit = a => Math.log(a / (1 - a)); // alpha [0..1] -> opacity

class Generator {
    // Optional: advertise params so the GUI renders live sliders for them.
    static params = [
        { name: 'width', label: 'Width', min: 1, max: 64, step: 1, default: 16 },
        { name: 'height', label: 'Height', min: 1, max: 64, step: 1, default: 16 },
        { name: 'scale', label: 'Scale (m)', min: 0.5, max: 20, step: 0.5, default: 4 }
    ];

    static async create(params) {
        // params is [{ name, value }, ...]; values are strings -> coerce here.
        const map = new Map(params.map(p => [p.name, p.value]));
        const num = (key, def) => {
            const v = map.get(key);
            const n = v === undefined ? def : Number(v);
            return Number.isFinite(n) ? n : def;
        };
        const width = Math.max(1, Math.floor(num('width', 8)));
        const height = Math.max(1, Math.floor(num('height', 8)));
        const scale = num('scale', 1);
        const logScale = Math.log(0.02 * scale); // gaussian radius, log space
        const opacity = toLogit(0.99);
        const spacing = 0.1 * scale;
        return {
            count: width * height,
            columnNames: ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2',
                'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'],
            getRow(index, row) {
                const col = index % width;
                const rowIdx = Math.floor(index / width);
                row.x = (col - (width - 1) / 2) * spacing;
                row.y = 0;
                row.z = (rowIdx - (height - 1) / 2) * spacing;
                row.scale_0 = row.scale_1 = row.scale_2 = logScale;
                row.rot_0 = 1; row.rot_1 = 0; row.rot_2 = 0; row.rot_3 = 0; // identity quat
                row.f_dc_0 = toSH(col / Math.max(1, width - 1));
                row.f_dc_1 = toSH(rowIdx / Math.max(1, height - 1));
                row.f_dc_2 = toSH(0.5);
                row.opacity = opacity;
            }
        };
    }
}

export { Generator };
`;

$<HTMLButtonElement>('add-sample-generator').onclick = () => {
    if (!api.getProject()) return showToast('Create or pick a project first', true);
    const file = new File([SAMPLE_GENERATOR], 'gen-grid.mjs', { type: 'text/javascript' });
    void uploadFiles([file]);
};

// ---------- live viewport preview (Edit transforms + region gizmos) ----------
const tfX = $<HTMLInputElement>('tf-translate-x'), tfY = $<HTMLInputElement>('tf-translate-y'), tfZ = $<HTMLInputElement>('tf-translate-z');
const rfX = $<HTMLInputElement>('tf-rotate-x'), rfY = $<HTMLInputElement>('tf-rotate-y'), rfZ = $<HTMLInputElement>('tf-rotate-z');
const tfScaleEl = $<HTMLInputElement>('tf-scale');


// ----- Edit-panel region fields (box/sphere) + transform preview live here -----
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
const ownerBoxFields = (): HTMLInputElement[] => [ecBoxMinX, ecBoxMinY, ecBoxMinZ, ecBoxMaxX, ecBoxMaxY, ecBoxMaxZ];
const ownerSphFields = (): HTMLInputElement[] => [ecSphX, ecSphY, ecSphZ, ecSphR];

const syncCropViz = () => {
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

const syncPreview = () => { syncSplatXform(); syncCropViz(); };
// until edit-panel.ts exists: files/viewport re-sync the preview through these
viewportCallbacks.syncPreview = syncPreview;
afterViewFileHooks.push(syncPreview);

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
const regionMode = (): 'remove' | 'keep' => regionModeEl.value === 'keep' ? 'keep' : 'remove';
const carveRegion = (): { box?: string[]; sphere?: [number, number, number, number] } | null => {
    const box = ecBoxOn() ? [ecBoxMinX.value, ecBoxMinY.value, ecBoxMinZ.value, ecBoxMaxX.value, ecBoxMaxY.value, ecBoxMaxZ.value] : undefined;
    const sphere = ecSphOn() ? [Number(ecSphX.value), Number(ecSphY.value), Number(ecSphZ.value), Number(ecSphR.value)] as [number, number, number, number] : undefined;
    return box || sphere ? { box, sphere } : null;
};
const syncCarveBtn = (): void => { carveRemoveBtn.disabled = !carveRegion(); };
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
for (const id of ['carve-box-on', 'carve-sphere-on']) $(id).addEventListener('change', () => { syncCarveBtn(); updateGroupApply(); });
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

// ---------- collision region box + sphere (viewport <-> Collision-panel fields) ----------
// region-pair row toggles, before the seeding listeners (today's order); this
// registration moves into region-panel.ts with the rest of the section
for (const cb of ['region-box-on', 'region-sphere-on']) $(cb).addEventListener('change', syncActionRows);
const regMinX = $<HTMLInputElement>('region-min-x'), regMinY = $<HTMLInputElement>('region-min-y'), regMinZ = $<HTMLInputElement>('region-min-z');
const regMaxX = $<HTMLInputElement>('region-max-x'), regMaxY = $<HTMLInputElement>('region-max-y'), regMaxZ = $<HTMLInputElement>('region-max-z');
const regSphX = $<HTMLInputElement>('region-sphere-x'), regSphY = $<HTMLInputElement>('region-sphere-y'), regSphZ = $<HTMLInputElement>('region-sphere-z'), regSphR = $<HTMLInputElement>('region-sphere-r');
const regionBoxOn = () => $<HTMLInputElement>('region-box-on').checked;
const regionSphereOn = () => $<HTMLInputElement>('region-sphere-on').checked;
const regionShadeEl = $<HTMLInputElement>('region-shade');

const syncRegionViz = () => {
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
afterViewFileHooks.push(syncRegionViz); // until region-panel.ts exists

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
    const r2 = (n: number) => Math.round(n * 100) / 100;
    regSphX.value = String(r2((b.min[0] + b.max[0]) / 2));
    regSphY.value = String(r2((b.min[1] + b.max[1]) / 2));
    regSphZ.value = String(r2((b.min[2] + b.max[2]) / 2));
    regSphR.value = String(r2(Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1) / 2));
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
const updateRegionEstimate = () => {
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
afterViewFileHooks.push(updateRegionEstimate); // until region-panel.ts exists
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

// the Edit-panel transform fields (-t/-r/-s), fanned by the Apply transform button
// and the linked-group apply (so a group edit replays the same transform on each member)
const editTransformOptions = () => ({
    translate: [Number(tfX.value), Number(tfY.value), Number(tfZ.value)] as [number, number, number],
    rotate: [Number(rfX.value), Number(rfY.value), Number(rfZ.value)] as [number, number, number],
    scale: Number(tfScaleEl.value)
});

// ---------- linked group: apply the Convert transforms/filters to every member ----------
// Edit on a proxy (the loaded splat / Convert input), then fan the same transform +
// filter ops out to every ticked member — the LODs of one location stay consistent.
const groupMembersEl = $<HTMLDivElement>('group-members');
const groupApplyBtn = $<HTMLButtonElement>('group-apply');
const groupApplyRegionBtn = $<HTMLButtonElement>('group-apply-region');
const groupWarn = $<HTMLDivElement>('group-warn');

const checkedMembers = (): string[] =>
    [...groupMembersEl.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);

const updateGroupApply = (): void => {
    const n = checkedMembers().length;
    const suffix = n ? `to ${n} member${n > 1 ? 's' : ''}` : 'to members';
    groupApplyBtn.textContent = `Apply transforms ${suffix}`;
    groupApplyBtn.disabled = n === 0;
    groupApplyRegionBtn.textContent = `Apply region ${suffix}`;
    groupApplyRegionBtn.disabled = n === 0 || !carveRegion(); // needs a box/sphere set in Edit
};

const persistGroup = (): void => {
    void api.saveGroup({ members: checkedMembers(), proxy: convertInput.value || null }).catch(() => { /* best-effort */ });
};

// (re)build the member checkboxes from the project splats, preserving the ticked set
const renderGroupMembers = (preselect: Set<string>): void => {
    groupMembersEl.innerHTML = '';
    for (const name of splatFileNames) {
        const row = document.createElement('label');
        row.className = 'group-member';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = name;
        cb.checked = preselect.has(name);
        cb.onchange = () => { updateGroupApply(); persistGroup(); };
        const span = document.createElement('span');
        span.textContent = name;
        row.append(cb, span);
        groupMembersEl.appendChild(row);
    }
    updateGroupApply();
};

// load the saved group for the active project and tick its members
const loadGroup = async (): Promise<void> => {
    let saved: api.LocationGroup = { members: [], proxy: null };
    try { saved = await api.getGroup(); } catch { /* none yet */ }
    renderGroupMembers(new Set(saved.members.filter((m) => splatFileNames.includes(m))));
};

// Files-panel bulk bar: add the selected splats to the linked group
$<HTMLButtonElement>('bulk-group').onclick = () => {
    const adds = [...selectedFiles].filter((n) => splatFileNames.includes(n));
    if (!adds.length) return showToast('No splat files selected — only splat files can join a linked group', true);
    renderGroupMembers(new Set([...checkedMembers(), ...adds]));
    persistGroup();
    showToast(`Added ${adds.length} file${adds.length > 1 ? 's' : ''} to the linked group`);
};

groupApplyBtn.onclick = async () => {
    const members = checkedMembers();
    if (!members.length) return showToast('Tick at least one member', true);
    if (!panelValid('panel-convert')) return;
    const format = convertFormat.value;
    if (format === 'csv') {
        return showToast('Pick a splat output format in the Export panel (PLY / SOG / …) — CSV doesn’t carry these per-gaussian edits', true);
    }
    groupWarn.classList.add('hidden');
    groupApplyBtn.disabled = true;
    groupApplyRegionBtn.disabled = true; // claim both buttons — the stats await below is a re-entrancy gap
    try {
        // frame-compat guard: members of one location should have similar extents
        const stats = (await Promise.all(members.map((m) => api.getStats(m).catch(() => null)))).filter(Boolean);
        const sizes = stats.map((s) => Math.max(...s!.extents.filter(Number.isFinite))).filter(Number.isFinite);
        if (sizes.length > 1) {
            const ratio = Math.max(...sizes) / Math.max(Math.min(...sizes), 1e-6);
            if (ratio > 3) {
                groupWarn.textContent = `These members span very different sizes (≈${ratio.toFixed(1)}× extent) — they may not be the same location.`;
                groupWarn.className = 'hint warn';
                if (!confirm('These members have quite different extents and may not be the same location. Apply the transforms to all of them anyway?')) return;
            }
        }
        // fan the Edit transform out to each member, one at a time — a member's
        // failure stops the loop before the rest submit
        const options = {
            ...editTransformOptions(),
            device: $<HTMLSelectElement>('convert-device').value
        };
        const outputs: string[] = [];
        for (const member of members) {
            const job = await runJob(() => api.startConvert({ input: member, format, options }), undefined, false);
            if (!job || job.status !== 'done') { showToast(`Stopped — ${baseLabel(member)} did not finish`, true); break; }
            outputs.push(...job.outputs);
        }
        if (outputs.length) showToast(`Applied to ${outputs.length} member${outputs.length > 1 ? 's' : ''}: ${outputs.join(', ')}`);
    } finally {
        updateGroupApply(); // restore the enabled state + count label
    }
};

// fan the Edit-panel Region (carve / crop) out to every ticked member — a removal or
// crop on the proxy propagates to all its LODs. Any-format members work (non-PLY ones
// are decompressed to PLY by the trim worker); each writes a trimmed .ply.
groupApplyRegionBtn.onclick = async () => {
    const members = checkedMembers();
    if (!members.length) return showToast('Tick at least one member', true);
    const region = carveRegion();
    if (!region) return showToast('Enable a Box or Sphere region in the Edit panel first', true);
    const mode = regionMode();
    const verb = mode === 'keep' ? 'Crop (keep only inside the region)' : 'Carve (remove inside the region)';
    if (!confirm(`${verb} on ${members.length} member${members.length > 1 ? 's' : ''}? Each writes a new trimmed .ply — the sources are left untouched.`)) return;
    groupWarn.classList.add('hidden');
    groupApplyBtn.disabled = true;
    groupApplyRegionBtn.disabled = true; // claim both buttons for the run
    try {
        const outputs: string[] = [];
        for (const member of members) {
            const job = await runJob(() => api.startTrim({ input: member, options: { mode, ...region } }), undefined, false);
            if (!job || job.status !== 'done') { showToast(`Stopped — ${baseLabel(member)} did not finish`, true); break; }
            outputs.push(...job.outputs);
        }
        if (outputs.length) showToast(`Region applied to ${outputs.length} member${outputs.length > 1 ? 's' : ''}: ${outputs.join(', ')}`);
    } finally {
        updateGroupApply();
    }
};

// ---------- analyze panel + persistent stats card ----------
interface StatRow { col: string; min: string; max: string; median: string; mean: string; std: string; nans: string; infs: string; hist: string; }

// parse the CLI's --stats text output (job log): a "gaussians: N" header then a
// | Column | min | max | median | mean | stdDev | nans | infs | histogram | table
const parseSummary = (log: string): { rowCount: number; rows: StatRow[] } | null => {
    const rc = log.match(/^gaussians:\s*(\d+)/m);
    if (!rc) return null;
    const rows: StatRow[] = [];
    for (const line of log.split('\n')) {
        if (!line.trim().startsWith('|')) continue;
        const c = line.split('|').slice(1, -1).map((s) => s.trim());
        if (c.length < 9 || c[0] === 'Column' || /^-+$/.test(c[0])) continue;
        rows.push({ col: c[0], min: c[1], max: c[2], median: c[3], mean: c[4], std: c[5], nans: c[6], infs: c[7], hist: c[8] });
    }
    return rows.length ? { rowCount: Number(rc[1]), rows } : null;
};

const fmtNum = (s: string): string => {
    const n = Number(s);
    if (!Number.isFinite(n)) return s;
    if (n !== 0 && (Math.abs(n) >= 100000 || Math.abs(n) < 0.001)) return n.toPrecision(4);
    return String(Math.round(n * 1000) / 1000);
};

let lastSummaryMarkdown = '';
// render the persistent Analyze card from a summary job's --stats log
const renderSummaryCard = (name: string, log: string): void => {
    const result = $('analyze-result');
    const summary = parseSummary(log);
    if (!summary) { result.classList.add('hidden'); showToast('Could not parse summary output', true); return; }
    const head = log.search(/^gaussians:/m);
    lastSummaryMarkdown = (head >= 0 ? log.slice(head) : log).trim();
    $('analyze-result-name').textContent = name;

    const extent = (col: string): number => {
        const r = summary.rows.find((x) => x.col === col);
        return r ? Number(r.max) - Number(r.min) : NaN;
    };
    const [ex, ey, ez] = ['x', 'y', 'z'].map(extent);
    const issues = summary.rows.reduce((a, r) => a + (Number(r.nans) || 0) + (Number(r.infs) || 0), 0);

    const tiles = $('stat-tiles');
    tiles.innerHTML = '';
    const tile = (label: string, value: string, cls = ''): void => {
        const t = document.createElement('div');
        t.className = `tile ${cls}`.trim();
        const v = document.createElement('span'); v.className = 'tile-val'; v.textContent = value;
        const l = document.createElement('span'); l.className = 'tile-label'; l.textContent = label;
        t.append(v, l);
        tiles.appendChild(t);
    };
    tile('Gaussians', Number.isFinite(summary.rowCount) ? summary.rowCount.toLocaleString() : '—');
    tile('Extent (m)', [ex, ey, ez].every(Number.isFinite)
        ? `${fmtNum(String(ex))} × ${fmtNum(String(ey))} × ${fmtNum(String(ez))}` : '—');
    tile(issues ? 'NaN / Inf' : 'Data', issues ? String(issues) : '✓ clean', issues ? 'bad' : 'good');

    const table = $<HTMLTableElement>('stats-table');
    table.innerHTML = '';
    const thead = table.createTHead().insertRow();
    for (const h of ['Column', 'min', 'max', 'median', 'mean', 'σ', 'NaN', 'Inf', 'dist']) {
        const th = document.createElement('th'); th.textContent = h; thead.appendChild(th);
    }
    const tbody = table.createTBody();
    for (const r of summary.rows) {
        const tr = tbody.insertRow();
        if ((Number(r.nans) || 0) + (Number(r.infs) || 0) > 0) tr.className = 'row-bad';
        const cells = [r.col, fmtNum(r.min), fmtNum(r.max), fmtNum(r.median), fmtNum(r.mean), fmtNum(r.std), r.nans, r.infs, r.hist];
        cells.forEach((text, i) => {
            const td = tr.insertCell();
            td.textContent = text;
            if (i === 0) td.className = 'col';
            if (i === 8) td.className = 'hist';
        });
    }
    result.classList.remove('hidden');
};

$<HTMLButtonElement>('stats-copy').onclick = () => {
    if (!lastSummaryMarkdown) return;
    void navigator.clipboard.writeText(lastSummaryMarkdown)
        .then(() => showToast('Summary copied'))
        .catch(() => showToast('Copy failed', true));
};

analyzeRun.onclick = async () => {
    const input = analyzeInput.value;
    if (!input) return showToast('Pick a file to analyze first', true);
    const job = await runJob(() => api.startAnalyze(input), analyzeRun);
    if (job?.status === 'done') renderSummaryCard(input, job.log);
};

// ---------- edit panel: measure → scale, set origin ----------
const measureToggle = $<HTMLInputElement>('measure-toggle');
const originToggle = $<HTMLInputElement>('origin-toggle');
const measureReadout = $<HTMLSpanElement>('measure-readout');
const editAbtn = $<HTMLButtonElement>('measure-edit-a');
const editBbtn = $<HTMLButtonElement>('measure-edit-b');

let nextMarker: 'a' | 'b' = 'a';
const reflectActiveMarker = (which: 'a' | 'b'): void => {
    nextMarker = which;
    editAbtn.classList.toggle('active', which === 'a');
    editBbtn.classList.toggle('active', which === 'b');
};

const updateMeasureReadout = (d?: number): void => {
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

// ---------- collision panel ----------
const preset = $<HTMLSelectElement>('collision-preset');
const fillMode = $<HTMLSelectElement>('fill-mode');
const seedX = $<HTMLInputElement>('seed-x');
const seedY = $<HTMLInputElement>('seed-y');
const seedZ = $<HTMLInputElement>('seed-z');
const carveHeight = $<HTMLInputElement>('carve-height');
const carveRadius = $<HTMLInputElement>('carve-radius');

// keep the in-viewport seed marker + carve capsule in sync with the fields
const syncSeedViz = () => {
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
const syncCollisionRows = () => {
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
    $<HTMLInputElement>('carve-height').value = String(p.carveHeight);
    $<HTMLInputElement>('carve-radius').value = String(p.carveRadius);
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
    if ((regionBoxOn() || regionSphereOn()) && regionRiskLevel === 'danger' &&
        !confirm('This region may exceed splat-transform\'s marching-cubes vertex limit (RangeError: Map maximum size exceeded). Shrink the region or raise the voxel size to be safe. Generate anyway?')) return;
    void runJob(() => api.startCollision({
        input,
        options: {
            voxelSize: Number($<HTMLInputElement>('voxel-size').value),
            opacity: Number($<HTMLInputElement>('voxel-opacity').value),
            filterCluster: $<HTMLInputElement>('filter-cluster').checked,
            seedPos: [
                Number($<HTMLInputElement>('seed-x').value),
                Number($<HTMLInputElement>('seed-y').value),
                Number($<HTMLInputElement>('seed-z').value)
            ],
            fillMode: fillMode.value as 'none' | 'external' | 'floor',
            fillSize: Number($<HTMLInputElement>('fill-size').value),
            carve: carveBox.checked,
            carveHeight: Number($<HTMLInputElement>('carve-height').value),
            carveRadius: Number($<HTMLInputElement>('carve-radius').value),
            meshShape: $<HTMLSelectElement>('mesh-shape').value as 'smooth' | 'faces',
            filterBox: $<HTMLInputElement>('region-box-on').checked ? [
                $<HTMLInputElement>('region-min-x').value, $<HTMLInputElement>('region-min-y').value, $<HTMLInputElement>('region-min-z').value,
                $<HTMLInputElement>('region-max-x').value, $<HTMLInputElement>('region-max-y').value, $<HTMLInputElement>('region-max-z').value
            ] : undefined,
            filterSphere: $<HTMLInputElement>('region-sphere-on').checked ? [
                Number($<HTMLInputElement>('region-sphere-x').value),
                Number($<HTMLInputElement>('region-sphere-y').value),
                Number($<HTMLInputElement>('region-sphere-z').value),
                Number($<HTMLInputElement>('region-sphere-r').value)
            ] : undefined
        }
    }), collisionRun, $<HTMLInputElement>('collision-autoload').checked);
};

// Settings ▸ About: component versions (PlayCanvas from the bundled engine, app + splat-transform from the server)
void (async () => {
    const set = (id: string, v: string | null | undefined) => { const el = $(id); el.textContent = v ? `v${v}` : 'unknown'; };
    set('ver-playcanvas', SplatViewer.engineVersion);
    try { const v = await api.getVersions(); set('ver-app', v.app); set('ver-splat-transform', v.splatTransform); }
    catch { set('ver-app', null); set('ver-splat-transform', null); }
})();

// ---------- global undo / redo ----------
// Snapshot-based over the undoable app state (form fields + loaded splat + layer
// visibility). Each committed change captures a snapshot (debounced so a gizmo drag
// = one step); Ctrl+Z / Ctrl+Y step through them. Job runs and file deletes are NOT
// undoable — they have filesystem side effects.
interface UndoSnap { fields: Record<string, string | boolean>; splat: string | null; layers: Record<string, boolean> }
// snapshot the CURRENT value of every id'd form control (not just changed ones), so
// undoing past a field's first edit still restores its original value
const takeSnap = (): UndoSnap => {
    const fields: Record<string, string | boolean> = {};
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[id], select[id]')) {
        if (el.id === 'project-select') continue; // switching projects is navigation, not an edit
        // server/desktop-owned settings (MCP consent, update prefs) are not edits —
        // undoing must never flip consent or the update channel as a side effect
        if (EXTERNAL_STATE_IDS.has(el.id)) continue;
        if (el instanceof HTMLInputElement && (el.type === 'file' || el.type === 'button' || el.type === 'submit')) continue;
        fields[el.id] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
    }
    return { fields, splat: currentSplatName, layers: { ...layerVisible } };
};
const clearUndoHistory = (): void => { clearTimeout(undoTimer); undoStack.length = 0; redoStack.length = 0; undoCurrent = takeSnap(); };
const snapKey = (s: UndoSnap): string => JSON.stringify(s);
const undoStack: UndoSnap[] = [];
const redoStack: UndoSnap[] = [];
let undoCurrent: UndoSnap = takeSnap();
let undoApplying = false;
let undoEnabled = false; // suppressed during boot (file-select population shouldn't be undoable)
let undoTimer = 0;
const MAX_UNDO = 100;
const canUndo = (): boolean => undoStack.length > 0;
const canRedo = (): boolean => redoStack.length > 0;

const captureUndo = (): void => {
    if (undoApplying) return;
    const next = takeSnap();
    if (snapKey(next) === snapKey(undoCurrent)) return;
    undoStack.push(undoCurrent);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    undoCurrent = next;
};
// called on every committed change; debounced so a burst (e.g. a gizmo drag that
// dispatches change on several fields) collapses into one undo step
const scheduleUndoCapture = (): void => {
    if (undoApplying || !undoEnabled) return;
    clearTimeout(undoTimer);
    undoTimer = window.setTimeout(captureUndo, 250);
};
hooks.scheduleUndoCapture = scheduleUndoCapture; // form-state's change listener calls through the hook
// enable undo capture once after boot settles, discarding any boot-time steps
const enableUndo = (): void => { undoEnabled = true; clearUndoHistory(); };

const applySnap = async (snap: UndoSnap): Promise<void> => {
    undoApplying = true;
    clearTimeout(undoTimer);
    try {
        for (const [id, value] of Object.entries(snap.fields)) {
            const el = document.getElementById(id);
            if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) continue;
            const isCb = el instanceof HTMLInputElement && el.type === 'checkbox';
            const cur: string | boolean = isCb ? (el as HTMLInputElement).checked : el.value;
            if (cur === value) continue;
            if (isCb) (el as HTMLInputElement).checked = value === true;
            else el.value = String(value);
            formState[id] = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true })); // re-sync gizmos/preview/persistence
        }
        localStorage.setItem(FORM_KEY, JSON.stringify(formState));
        // reload the splat FIRST — viewFile force-shows it, so restore layer visibility after
        if (snap.splat !== currentSplatName) {
            if (snap.splat == null) removeSplat();
            else await viewFile(snap.splat, 'splat');
        }
        for (const id of Object.keys(layerVisible) as LayerId[]) {
            if (layerVisible[id] !== snap.layers[id]) toggleLayer(id);
        }
    } finally {
        undoApplying = false;
        undoCurrent = takeSnap(); // reflect the actual post-apply state (a load may have failed)
    }
};

const doUndo = (): void => {
    if (undoApplying || !canUndo()) return;
    redoStack.push(undoCurrent);
    undoCurrent = undoStack.pop()!;
    void applySnap(undoCurrent);
};
const doRedo = (): void => {
    if (undoApplying || !canRedo()) return;
    undoStack.push(undoCurrent);
    undoCurrent = redoStack.pop()!;
    void applySnap(undoCurrent);
};

document.addEventListener('keydown', (e) => {
    if (e.repeat || !(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    // keep native undo/redo inside a text field the user is editing
    const ae = document.activeElement;
    if (ae instanceof HTMLTextAreaElement || (ae instanceof HTMLInputElement && /^(text|number|search|email|url|tel|password|)$/.test(ae.type))) return;
    e.preventDefault();
    if (k === 'y' || (k === 'z' && e.shiftKey)) doRedo();
    else doUndo();
});

function buildMenuBar(): void {
    const bar = $('menubar');
    bar.innerHTML = '';
    bar.append(
        makeMenu('Edit', () => [
            { label: 'Undo  (Ctrl+Z)', disabled: !canUndo(), onClick: doUndo },
            { label: 'Redo  (Ctrl+Y)', disabled: !canRedo(), onClick: doRedo }
        ]),
        makeMenu('Window', () => [
            ...WINDOWS.map((w) => ({
                label: w.title,
                checked: !!dock.getPanel(w.id),
                onClick: () => { if (dock.getPanel(w.id)) { if (w.closable) closeWindow(w); else openWindow(w); } else openWindow(w); }
            })),
            { label: 'Settings…', checked: settingsOpen(), onClick: () => { if (settingsOpen()) closeSettings(); else openSettings(); } }
        ]),
        makeMenu('Layout', () => [
            { label: 'Reset to default', onClick: () => { applyDefaultLayout(); persistNow(); } },
            { label: 'Save layout', onClick: persistNow }
        ])
    );
}
buildMenuBar();

// ---------- settings dialog ----------
const settingsBackdrop = $<HTMLDivElement>('settings-backdrop');
function settingsOpen(): boolean { return !settingsBackdrop.classList.contains('hidden'); }
function showSettingsPage(page: string): void {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#settings-nav .settings-nav-item')) {
        b.classList.toggle('active', b.dataset.page === page);
    }
    for (const p of document.querySelectorAll<HTMLElement>('.settings-page')) {
        p.classList.toggle('hidden', p.dataset.page !== page);
    }
}
function openSettings(page?: string): void {
    settingsBackdrop.classList.remove('hidden');
    if (page) showSettingsPage(page);
}
function closeSettings(): void { settingsBackdrop.classList.add('hidden'); }
for (const b of document.querySelectorAll<HTMLButtonElement>('#settings-nav .settings-nav-item')) {
    b.onclick = () => showSettingsPage(b.dataset.page ?? 'appearance');
}
$<HTMLButtonElement>('settings-close').onclick = closeSettings;
settingsBackdrop.addEventListener('pointerdown', (e) => { if (e.target === settingsBackdrop) closeSettings(); });
// promptText's capture-phase Escape handler wins while a prompt is up
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && settingsOpen()) closeSettings(); });
initThemeSettings({ promptText, showToast });
(window as unknown as { __settings: { open: (page?: string) => void; close: () => void } }).__settings = { open: openSettings, close: closeSettings }; // capture harness handle (scripts/capture-docs.mjs)

// the viewport toolbar's ⚙ opens the settings dialog
$<HTMLButtonElement>('open-settings').onclick = () => openSettings();

// ---------- Settings ▸ Updates + bottom-right status widget ----------
// The Electron preload bridge (electron/preload.cjs); absent in the browser dev
// build. Update members are optional so an older shell degrades gracefully.
interface UpdateStatus { phase: string; version?: string; percent?: number; channel?: string; message?: string }
interface DesktopApi {
    pickFolder(defaultPath?: string): Promise<string | null>;
    persistWorkspace(path: string): Promise<void>;
    openWorkspace(): Promise<void>;
    onChooseWorkspace(cb: () => void): void;
    checkForUpdates?: () => Promise<void>;
    getUpdateChannel?: () => Promise<'stable' | 'beta'>;
    setUpdateChannel?: (c: 'stable' | 'beta') => Promise<'stable' | 'beta'>;
    getUpdateStatus?: () => Promise<UpdateStatus>;
    onUpdateStatus?: (cb: (s: UpdateStatus) => void) => void;
    downloadUpdate?: () => Promise<void>;
    getUpdateAuto?: () => Promise<boolean>;
    setUpdateAuto?: (on: boolean) => Promise<boolean>;
}

// Only meaningful in the packaged desktop app; drop both in the browser dev build.
void (async () => {
    const bridge = (window as unknown as { desktop?: DesktopApi }).desktop;
    const navItem = document.querySelector<HTMLButtonElement>('#settings-nav .settings-nav-item[data-page="updates"]');
    const page = document.querySelector<HTMLElement>('.settings-page[data-page="updates"]');
    const widget = $<HTMLDivElement>('update-widget');
    if (!bridge?.getUpdateChannel) { navItem?.remove(); page?.remove(); widget.remove(); return; }

    const channelSel = $<HTMLSelectElement>('update-channel');
    const checkBtn = $<HTMLButtonElement>('check-updates');
    const downloadBtn = $<HTMLButtonElement>('download-update');
    const autoChk = $<HTMLInputElement>('update-auto');
    const statusEl = $<HTMLSpanElement>('update-status');
    const statusText = $<HTMLSpanElement>('update-status-text');
    const widgetText = $<HTMLSpanElement>('update-widget-text');
    const widgetBar = $<HTMLSpanElement>('update-widget-bar');
    const widgetFill = $<HTMLSpanElement>('update-widget-fill');
    const widgetDownload = $<HTMLButtonElement>('update-widget-download');
    try { channelSel.value = await bridge.getUpdateChannel(); } catch { /* keep default */ }
    try { autoChk.checked = await bridge.getUpdateAuto?.() ?? true; } catch { /* keep default */ }

    // settings status line + bottom-right widget both mirror main-process updater
    // state; checks/downloads keep running with the settings dialog closed
    const showStatus = (s: UpdateStatus): void => {
        const busy = s.phase === 'checking' || s.phase === 'downloading';
        const pct = Math.round(s.percent ?? 0);
        const text =
            s.phase === 'checking' ? 'Checking for updates…' :
            s.phase === 'available' ? `${s.version} available` :
            s.phase === 'downloading' ? `Downloading ${s.version ?? 'update'}… ${pct}%` :
            s.phase === 'ready' ? `${s.version} downloaded — restart to install` :
            s.phase === 'up-to-date' ? `Up to date (${s.version}, ${s.channel})` :
            s.phase === 'error' ? 'Check failed — see error dialog' : '';
        statusEl.classList.toggle('hidden', !text);
        statusEl.classList.toggle('busy', busy);
        statusEl.classList.toggle('error', s.phase === 'error');
        statusText.textContent = text;
        checkBtn.disabled = busy;
        channelSel.disabled = busy;
        downloadBtn.classList.toggle('hidden', s.phase !== 'available');

        const widgetLabel =
            s.phase === 'checking' ? 'Checking for updates…' :
            s.phase === 'available' ? `⬇ ${s.version} available` :
            s.phase === 'downloading' ? `${pct}%` :
            s.phase === 'ready' ? `↻ Restart to update` :
            s.phase === 'up-to-date' ? '✓ Up to date' :
            s.phase === 'error' ? '⚠ Update failed' : '';
        widget.classList.toggle('hidden', !widgetLabel);
        widget.classList.toggle('busy', s.phase === 'checking');
        widget.classList.toggle('error', s.phase === 'error');
        widgetText.textContent = widgetLabel;
        widgetBar.classList.toggle('hidden', s.phase !== 'downloading');
        widgetFill.style.width = `${pct}%`;
        widgetDownload.classList.toggle('hidden', s.phase !== 'available');
    };
    bridge.onUpdateStatus?.(showStatus);
    try { showStatus(await bridge.getUpdateStatus?.() ?? { phase: 'idle' }); } catch { /* keep hidden */ }

    channelSel.addEventListener('change', () => { void bridge.setUpdateChannel?.(channelSel.value as 'stable' | 'beta'); });
    checkBtn.addEventListener('click', () => { void bridge.checkForUpdates?.(); });
    autoChk.addEventListener('change', () => { void bridge.setUpdateAuto?.(autoChk.checked); });
    downloadBtn.addEventListener('click', () => { void bridge.downloadUpdate?.(); });
    widgetDownload.addEventListener('click', () => { void bridge.downloadUpdate?.(); });
    // the widget body always leads to the settings page, whatever the state
    $<HTMLButtonElement>('update-widget-main').addEventListener('click', () => openSettings('updates'));
})();

// ---------- projects ----------
const PROJECT_KEY = 'splat-studio.project';

const switchProject = async (name: string) => {
    api.setProject(name);
    projectSelect.value = name;
    localStorage.setItem(PROJECT_KEY, name);
    lodMetaCache.clear(); // keyed name@mtime within a project
    // loaded layers belong to the project we're leaving
    clearViewport();
    await refreshFiles();
    await loadGroup(); // tick the saved group members for this project
    clearUndoHistory(); // undo history doesn't span a project switch
};

// refresh the project picker; selects `preferred` (or the first project)
const loadProjects = async (preferred?: string) => {
    const projects = await api.listProjects();
    projectSelect.innerHTML = '';
    for (const name of projects) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        projectSelect.appendChild(opt);
    }
    if (projects.length === 0) {
        api.setProject('');
        // clear anything from the workspace we just left (no project to refreshFiles)
        clearViewport();
        fileList.innerHTML = '';
        showToast('No projects yet — click "+ New" to create one', true);
        return;
    }
    await switchProject(projects.includes(preferred ?? '') ? preferred! : projects[0]);
};

projectSelect.onchange = () => void switchProject(projectSelect.value)
    .catch((err) => showToast(`Couldn't switch project: ${err}`, true));

$<HTMLButtonElement>('project-new').onclick = async () => {
    const name = await promptText('New project name', { okLabel: 'Create', placeholder: 'my-scene' });
    if (!name) return;
    try {
        await api.createProject(name);
        await loadProjects(name);
        showToast(`Created project "${name}"`);
    } catch (err) {
        showToast(`Couldn't create project: ${err}`, true);
    }
};

// ---------- boot ----------
// keep the scene list fresh when tabs change (the capsule item depends on the
// Collision tab being visible) or the Scene tab is shown; the render frustum +
// camera-view preview are gated on the Render tab being the active one
dock.onDidActivePanelChange(() => { updateRenderFrustum(); rebuildSceneList(); });

// re-apply persisted form values, then re-run the row/label syncs that already
// fired at panel-module eval (i.e. before restore) so they reflect restored values
restoreFormState();
updateConvertRows();
updateLodRows();
updateInputRows();
void updateGenRows();
syncActionRows();
syncCollisionRows();
syncCarveBtn();

// populate the device dropdowns with GPU adapters (-L), then reapply any saved choice
void api.listGpus().then((gpus) => {
    for (const id of ['convert-device', 'lod-device', 'render-device']) {
        const sel = $<HTMLSelectElement>(id);
        for (const g of gpus) {
            const opt = document.createElement('option');
            opt.value = String(g.index);
            opt.textContent = `GPU ${g.index}: ${g.name}`;
            sel.appendChild(opt);
        }
        const want = formState[id];
        if (typeof want === 'string' && [...sel.options].some((o) => o.value === want)) sel.value = want;
    }
}).catch(() => { /* device list is best-effort */ });

void bootLayout();
// projects (and the active project's files) load first; renderer comes up in parallel
void loadProjects(localStorage.getItem(PROJECT_KEY) ?? undefined)
    .catch((err) => showToast(`Can't reach the local server — projects unavailable (${err})`, true))
    .finally(enableUndo); // begin undo history once the initial project + files have loaded
void SplatViewer.create($<HTMLCanvasElement>('gs-canvas'))
    .then((v) => {
        setViewer(v);
        // sync restored control values into the freshly created viewer
        v.setWireColor($<HTMLInputElement>('wire-color').value);
        v.setWireOpacity(Number($<HTMLInputElement>('wire-opacity').value));
        v.setVoxelColor($<HTMLInputElement>('voxel-color').value);
        v.setVoxelOpacity(Number($<HTMLInputElement>('voxel-opacity').value));
        v.setCollisionStyle($<HTMLSelectElement>('collision-style').value as 'xray' | 'hidden' | 'solid');
        v.setCollisionFlipped($<HTMLInputElement>('collision-flip').checked);
        // gizmo drag -> reflect into the seed fields (live), persist on release
        v.onSeedMove = (cli) => {
            seedX.value = String(cli.x);
            seedY.value = String(cli.y);
            seedZ.value = String(cli.z);
        };
        v.onSeedMoveEnd = () => {
            // bubbles:true so the delegated form-state listener on document persists it
            for (const el of [seedX, seedY, seedZ]) el.dispatchEvent(new Event('change', { bubbles: true }));
            syncSeedViz(); // snap the node to the rounded field values
        };
        syncSeedViz();
        // crop gizmo -> reflect into the OWNING panel's box/sphere fields (Convert crop
        // or Edit carve), live; persist on release
        v.onCropSphereMove = (c) => { const [x, y, z] = ownerSphFields(); x.value = String(c.x); y.value = String(c.y); z.value = String(c.z); };
        v.onCropBoxMove = (d) => {
            const shift = (el: HTMLInputElement, dv: number) => { if (el.value.trim() !== '') el.value = String(Math.round((Number(el.value) + dv) * 100) / 100); };
            const [minX, minY, minZ, maxX, maxY, maxZ] = ownerBoxFields();
            shift(minX, d.x); shift(maxX, d.x);
            shift(minY, d.y); shift(maxY, d.y);
            shift(minZ, d.z); shift(maxZ, d.z);
        };
        v.onCropMoveEnd = () => {
            for (const el of [...ownerBoxFields(), ...ownerSphFields()]) el.dispatchEvent(new Event('change', { bubbles: true }));
            syncCropViz();
        };
        // crop face/radius handles -> set just the dragged value (blank sides stay unbounded)
        v.onCropBoxFace = (axis, sign, value) => {
            ownerBoxFields()[(sign > 0 ? 3 : 0) + axis].value = String(value);
        };
        v.onCropSphereRadius = (r) => { ownerSphFields()[3].value = String(r); };
        // region box gizmo -> reflect absolute corners into the fields (live), persist on release
        v.onRegionBoxChange = (min, max) => {
            regMinX.value = String(min.x); regMinY.value = String(min.y); regMinZ.value = String(min.z);
            regMaxX.value = String(max.x); regMaxY.value = String(max.y); regMaxZ.value = String(max.z);
        };
        v.onRegionBoxEnd = () => {
            for (const el of [regMinX, regMinY, regMinZ, regMaxX, regMaxY, regMaxZ]) el.dispatchEvent(new Event('change', { bubbles: true }));
            syncRegionViz();
            updateRegionEstimate();
        };
        // region sphere gizmo/knob -> reflect centre + radius into the fields (live), persist on release
        v.onRegionSphereChange = (c, r) => {
            regSphX.value = String(c.x); regSphY.value = String(c.y); regSphZ.value = String(c.z);
            regSphR.value = String(r);
        };
        v.onRegionSphereEnd = () => {
            for (const el of [regSphX, regSphY, regSphZ, regSphR]) el.dispatchEvent(new Event('change', { bubbles: true }));
            syncRegionViz();
            updateRegionEstimate();
        };
        v.setRegionFaceOpacity(Number(regionShadeEl.value));
        v.setBoundsVisible($<HTMLInputElement>('show-bounds').checked);
        // live measure readout + active-marker highlight as points are clicked in
        v.onMeasureChange = (d) => { if (measureToggle.checked) updateMeasureReadout(d); };
        v.onActiveMarkerChange = (which) => reflectActiveMarker(which);
        v.onEditPlaced = () => updateMeasureReadout();
        // scene hierarchy: reflect selection changes, and let the render-camera
        // gizmo drive the WebP camera/look-at fields
        v.onSelectionChange = () => rebuildSceneList();
        v.onRenderCameraMove = (cam, look) => {
            writeVecField('webp-camera', `${cam.x},${cam.y},${cam.z}`);
            writeVecField('webp-lookat', `${look.x},${look.y},${look.z}`);
            updateRenderFrustum();
        };
        v.setCameraMode($<HTMLSelectElement>('camera-mode').value as 'fly' | 'orbit');
        const cvc = getCameraViewCanvas();
        if (cvc) v.setupCameraView(cvc); // a Camera-view panel opened before the viewer booted
        syncPreview(); // reflect restored Convert fields once the viewer is up
        syncRegionViz(); // reflect a restored collision region box
        updateRegionEstimate(); // and its overflow risk
        updateRenderFrustum(); // show the render frustum if the Render tab is active
        rebuildSceneList();
        (window as unknown as { __viewer: SplatViewer }).__viewer = v; // capture harness handle (scripts/capture-docs.mjs, capture-readme.mjs)
    })
    .catch((err) => {
        showToast(`Failed to start viewer: ${err}`, true);
        console.error(err);
    });

// ---------- MCP editor bridge: dispatch commands through the real GUI actions ----------
// Handlers set form fields + dispatch input/change (or drive the real click path), so
// the gizmo, the panel form fields, and the persisted form state all update together.
const r4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const setField = (id: string, value: string | number): boolean => {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return false;
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
};
const setCheck = (id: string, on: boolean): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el && el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); }
};
const setBoxFields = (prefix: string, box: Array<number | string>): void => {
    const ax = ['min-x', 'min-y', 'min-z', 'max-x', 'max-y', 'max-z'];
    box.forEach((v, i) => setField(`${prefix}-${ax[i]}`, v === '-' || v === '' ? '' : (v as number)));
};
const need = <T>(v: T | null | undefined, msg: string): T => { if (v == null) editorError('bad-input', msg); return v as T; };

const mcpHandlers: Record<string, (p: Record<string, unknown>) => unknown> = {
    panel: ({ action, id }) => {
        // settings is a dialog now, but keeps its old panel id for MCP clients
        if (id === 'panel-settings') { if (action === 'close') closeSettings(); else openSettings(); return { id, action }; }
        const w = winById(String(id));
        if (!w) return editorError('not-found', `no panel "${id}"`);
        if (action === 'close') { if (w.closable) closeWindow(w); else editorError('bad-input', `panel "${id}" can't be closed`); }
        else openWindow(w);
        return { id, action };
    },
    layout: ({ action, layout }) => {
        if (action === 'get') return { layout: dock.toJSON() };
        if (action === 'reset') { applyDefaultLayout(); persistNow(); return { ok: true }; }
        if (action === 'set') {
            try { dock.fromJSON(layout as Parameters<DockviewApi['fromJSON']>[0]); reconcilePanelTitles(); persistNow(); }
            catch (e) { return editorError('bad-input', `invalid layout: ${(e as Error).message}`); }
            return { ok: true };
        }
        return editorError('bad-input', `unknown layout action "${action}"`);
    },
    load_into_viewport: async ({ action, project, file }) => {
        if (action === 'clear') { clearViewport(); return { cleared: true }; }
        if (project != null && String(project) !== projectSelect.value) {
            return editorError('bad-input', `project "${project}" is not the app's current project ("${projectSelect.value}") — the viewport loads from the current project only`);
        }
        const name = need(file as string, 'load needs file');
        const as: api.ViewKind = /\.voxel\.json$/i.test(name) ? 'voxel' : /collision\.glb$/i.test(name) ? 'collision' : 'splat';
        const ok = await viewFile(name, as);
        if (!ok) editorError('not-found', `couldn't load "${name}" — missing, not a viewable ${as}, or superseded`);
        return { loaded: name, as };
    },
    camera: ({ action, eye, target, mode }) => {
        const v = need(viewer, 'viewer not ready');
        if (action === 'get') return v.getCamera();
        if (action === 'frame') { v.frame(); return v.getCamera(); }
        if (action === 'mode') {
            if (mode === 'fly' || mode === 'orbit') setField('camera-mode', mode);
            else return editorError('bad-input', 'mode must be fly or orbit');
            return { mode };
        }
        if (action === 'set') { v.setCamera(need(eye as number[], 'set needs eye'), need(target as number[], 'set needs target')); return v.getCamera(); }
        return editorError('bad-input', `unknown camera action "${action}"`);
    },
    viewport_screenshot: async ({ maxWidth }) => await need(viewer, 'viewer not ready').captureScreenshot(Number(maxWidth) || undefined),
    viewport_click: ({ x, y }) => {
        const v = need(viewer, 'viewer not ready');
        const canvas = v.canvas;
        const rect = canvas.getBoundingClientRect();
        const px = Number(x) * rect.width, py = Number(y) * rect.height;
        const hit = v.pickSurfacePoint(px, py);
        // drive the real click path so the active marker + readouts update for the current tool
        const ev = (type: string) => canvas.dispatchEvent(new PointerEvent(type, { clientX: rect.left + px, clientY: rect.top + py, button: 0, bubbles: true }));
        ev('pointerdown'); ev('pointerup');
        return hit ? { hit: true, point: [r4(hit.x), r4(hit.y), r4(hit.z)] } : { hit: false };
    },
    select_item: ({ id }) => { selectScene((id == null ? 'none' : String(id)) as SelId); return { selection: viewer?.selection ?? 'none' }; },
    get_editor_state: () => {
        const activePanels = WINDOWS.map((w) => w.id).filter((id) => { const p = dock.getPanel(id); return !!p && p.group.activePanel?.id === id; });
        if (settingsOpen()) activePanels.push('panel-settings');
        return {
            project: projectSelect.value || null,
            loadedSplat: currentSplatName,
            activePanels,
            selection: viewer?.selection ?? 'none',
            items: viewer ? SCENE_ITEMS.filter((it) => it.has()).map((it) => it.id) : [],
            editTool: measureToggle.checked ? 'measure' : originToggle.checked ? 'origin' : 'none',
            layers: { ...layerVisible },
            camera: viewer?.getCamera() ?? null
        };
    },
    set_view_option: ({ option, value, target }) => {
        const v = need(viewer, 'viewer not ready');
        if (option === 'bounds') { setCheck('show-bounds', !!value); return { bounds: !!value }; }
        if (option === 'collision_style') {
            if (!['xray', 'hidden', 'solid'].includes(String(value))) return editorError('bad-input', 'collision_style must be xray, hidden, or solid');
            setField('collision-style', String(value));
            return { style: value };
        }
        if (option === 'layer') {
            const id = String(target) as LayerId;
            if (!(id in layerVisible)) return editorError('bad-input', `unknown layer "${target}"`);
            if (layerVisible[id] !== !!value) toggleLayer(id);
            return { layer: id, visible: layerVisible[id] };
        }
        if (option === 'skybox') {
            if (value == null) { v.clearSkybox(); return { skybox: null }; }
            return v.setSkybox(api.fileUrl(String(value)), String(value).split('/').pop() ?? String(value))
                .then((ok) => { if (!ok) editorError('not-found', `couldn't load skybox image "${value}"`); return { skybox: value }; });
        }
        return editorError('bad-input', `unknown option "${option}"`);
    },
    set_region: ({ target, box, sphere, enabled, gizmoMode }) => {
        if (target === 'crop_box') {
            setCheck('carve-box-on', enabled == null ? true : !!enabled);
            if (Array.isArray(box)) setBoxFields('carve-box', box as Array<number | string>);
            return { region: 'crop_box' };
        }
        if (target === 'crop_sphere') {
            setCheck('carve-sphere-on', enabled == null ? true : !!enabled);
            if (Array.isArray(sphere)) { const s = sphere as number[]; setField('carve-sphere-x', s[0]); setField('carve-sphere-y', s[1]); setField('carve-sphere-z', s[2]); setField('carve-sphere-r', s[3]); }
            return { region: 'crop_sphere' };
        }
        if (target === 'collision_region') {
            setCheck('region-box-on', enabled == null ? true : !!enabled);
            if (Array.isArray(box)) setBoxFields('region', box as Array<number | string>);
            return { region: 'collision_region', note: gizmoMode ? 'gizmoMode ignored — move + resize handles are always active' : undefined };
        }
        if (target === 'collision_sphere') {
            setCheck('region-sphere-on', enabled == null ? true : !!enabled);
            if (Array.isArray(sphere)) { const s = sphere as number[]; setField('region-sphere-x', s[0]); setField('region-sphere-y', s[1]); setField('region-sphere-z', s[2]); setField('region-sphere-r', s[3]); }
            return { region: 'collision_sphere' };
        }
        return editorError('bad-input', `unknown region target "${target}"`);
    },
    set_origin: ({ point }) => {
        const v = need(viewer, 'viewer not ready');
        setCheck('origin-toggle', true);
        if (Array.isArray(point)) v.placeMarkerAt(point as [number, number, number]);
        if (!v.markersPlaced) return { placed: false, note: 'origin mode on — place the point with viewport_click or pass point' };
        const t = v.originTranslateCli();
        return { placed: true, translate: [t.x, t.y, t.z] };
    },
    measure: ({ action, length, points }) => {
        const v = need(viewer, 'viewer not ready');
        if (action === 'set_length') {
            if (!(Number(length) > 0)) return editorError('bad-input', 'length must be > 0');
            setField('measure-length', Number(length));
            return { length };
        }
        if (Array.isArray(points) && points.length) {
            setCheck('measure-toggle', true);
            if (points.length === 2) v.setActiveMarker('a');
            for (const p of points as number[][]) v.placeMarkerAt(p as [number, number, number]);
        }
        const st = v.measureState();
        const len = Number($<HTMLInputElement>('measure-length').value);
        return { ...st, ...(st.distance > 0 && len > 0 ? { scale: r4(len / st.distance) } : {}) };
    },
    history: ({ action }) => {
        if (action !== 'get' && undoApplying) return editorError('bad-input', 'a previous undo/redo is still applying — retry in a moment');
        if (action === 'undo') { if (!canUndo()) return editorError('bad-input', 'nothing to undo'); doUndo(); }
        else if (action === 'redo') { if (!canRedo()) return editorError('bad-input', 'nothing to redo'); doRedo(); }
        else if (action !== 'get') return editorError('bad-input', `unknown history action "${action}"`);
        return { canUndo: canUndo(), canRedo: canRedo(), applying: undoApplying };
    },
    render_pose: ({ action, camera, lookAt }) => {
        if (action === 'get') return need(viewer?.cameraRenderPose(), 'no render pose available');
        if (action === 'set') {
            if (Array.isArray(camera)) (camera as number[]).forEach((n, i) => setField(vecFieldIds('webp-camera')[i], n));
            if (Array.isArray(lookAt)) (lookAt as number[]).forEach((n, i) => setField(vecFieldIds('webp-lookat')[i], n));
            return { ok: true };
        }
        return editorError('bad-input', `unknown render_pose action "${action}"`);
    },
    set_collision_gizmo: ({ target, seed, height, radius }) => {
        if (target === 'seed') { const s = need(seed as number[], 'seed needs [x,y,z]'); setField('seed-x', s[0]); setField('seed-y', s[1]); setField('seed-z', s[2]); return { seed: s }; }
        if (target === 'capsule') { setCheck('carve', true); if (height != null) setField('carve-height', Number(height)); if (radius != null) setField('carve-radius', Number(radius)); return { height, radius }; }
        return editorError('bad-input', `unknown gizmo target "${target}"`);
    }
};

// ---------- workspace folder (Settings) ----------
// The native folder picker lives in Electron (preload -> main); the actual switch
// goes through POST /api/workspace so it works headlessly (MCP) and in the browser.
const desktop = (window as unknown as { desktop?: DesktopApi }).desktop;
let currentWorkspace = '';
let wsSwitching = false;
const wsPathEl = $<HTMLInputElement>('ws-path');

const showWorkspace = (p: string): void => {
    currentWorkspace = p;
    wsPathEl.value = p;
    wsPathEl.title = p;
};

const applyWorkspace = async (target: string): Promise<void> => {
    wsSwitching = true;
    try {
        const ws = await api.setWorkspace(target);
        await desktop?.persistWorkspace(ws.path);
        showWorkspace(ws.path);
        await loadProjects();
        void syncEditorStatus(); // consent reset on switch — reflect it
        showToast(`Workspace set to ${ws.path}`);
    } finally {
        wsSwitching = false;
    }
};

const chooseWorkspaceFolder = async (): Promise<void> => {
    const target = desktop?.pickFolder
        ? await desktop.pickFolder(currentWorkspace)
        : await promptText('Workspace folder (absolute path)', { value: currentWorkspace, okLabel: 'Set' });
    if (!target) return;
    try { await applyWorkspace(target); }
    catch (err) { showToast(`Couldn't set workspace: ${err}`, true); }
};

// a workspace switch initiated elsewhere (an MCP agent) — reflect it live
const onWorkspaceSwitched = async (): Promise<void> => {
    if (wsSwitching) return; // our own switch already handles the UI
    try {
        const ws = await api.getWorkspace();
        if (ws.path === currentWorkspace) return;
        await desktop?.persistWorkspace(ws.path);
        showWorkspace(ws.path);
        await loadProjects();
        void syncEditorStatus(); // consent reset on switch — reflect it
        showToast(`Workspace set to ${ws.path}`);
    } catch { /* server momentarily unavailable */ }
};

$<HTMLButtonElement>('ws-change').onclick = () => void chooseWorkspaceFolder();
const wsOpenBtn = $<HTMLButtonElement>('ws-open');
if (desktop?.openWorkspace) { wsOpenBtn.hidden = false; wsOpenBtn.onclick = () => void desktop.openWorkspace(); }
desktop?.onChooseWorkspace(() => void chooseWorkspaceFolder());
void api.getWorkspace().then((ws) => showWorkspace(ws.path)).catch(() => { /* server not up yet */ });

// ---------- Settings ▸ Advanced: decimation scratch dir (--scratch-dir) ----------
const scratchDirEl = $<HTMLInputElement>('scratch-dir');
const setScratchDir = (v: string): void => {
    scratchDirEl.value = v;
    scratchDirEl.dispatchEvent(new Event('change', { bubbles: true })); // persist via formState
};
const chooseScratchDirFolder = async (): Promise<void> => {
    const target = desktop?.pickFolder
        ? await desktop.pickFolder(scratchDirEl.value || undefined)
        : await promptText('Scratch directory (absolute path)', { value: scratchDirEl.value, okLabel: 'Set' });
    if (target) setScratchDir(target);
};
$<HTMLButtonElement>('scratch-dir-change').onclick = () => void chooseScratchDirFolder();
$<HTMLButtonElement>('scratch-dir-clear').onclick = () => setScratchDir('');

// ---------- MCP consent toggle (Settings) + bridge startup ----------
const mcpControl = $<HTMLInputElement>('mcp-control');
const mcpStatusEl = $('mcp-status');
let mcpConnected = false; // last real bridge state, from onStatus
const updateMcpStatus = (connected: boolean): void => {
    mcpConnected = connected;
    mcpStatusEl.textContent = `Editor bridge: ${connected ? 'connected' : 'disconnected'} · control ${mcpControl.checked ? 'ON' : 'off'}`;
};
mcpControl.onchange = () => {
    void api.setEditorControl(mcpControl.checked)
        .then(() => updateMcpStatus(mcpConnected)) // re-render the label; keep the real connection state
        .catch(() => showToast('Failed to update MCP consent', true));
};
// reconcile the consent checkbox + label with the server's enforced state — also
// re-run after a workspace switch (consent is per-workspace and resets on switch)
const syncEditorStatus = (): Promise<void> =>
    api.getEditorStatus().then((s) => { mcpControl.checked = s.controlEnabled; updateMcpStatus(s.connected); }).catch(() => { /* server not up yet */ });
void syncEditorStatus();

ensureJobsPolling(); // pick up jobs already queued/running (e.g. MCP-submitted)
startMcpBridge({
    handlers: mcpHandlers,
    appVersion: '0.1.0',
    project: () => projectSelect.value || null,
    onEvent: (name) => {
        if (name === 'workspace-changed') void refreshFiles();
        else if (name === 'workspace-switched') void onWorkspaceSwitched();
        else if (name === 'job-updated') ensureJobsPolling(); // MCP-submitted jobs surface in the panel
    },
    onStatus: updateMcpStatus
});
