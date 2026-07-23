// App shell: imports every module in side-effect order, then runs the boot
// sequence — restored form state, layout, projects, the 3D viewer wiring, and
// the MCP bridge + consent toggle.
import './boot-theme'; // theme first — before any UI paints
import { $, projectSelect } from './dom';
import { setViewer, hooks } from './state';
import { showToast, syncPresetRows } from './ui';
import { round } from './line-meshes';
import { formState, restoreFormState } from './form-state';
import { dock, getCameraViewCanvas, bootLayout } from './dockview';
import { rebuildSceneList } from './viewport';
import { refreshFiles } from './files-panel';
import { ensureJobsPolling } from './jobs';
import { updateGenRows } from './generate-panel';
import { updateConvertRows, updateInputRows, syncActionRows } from './convert-panel';
import { updateLodRows } from './lod-panel';
import { writeVecField, updateRenderFrustum } from './render-panel';
import { syncPreview, syncCropViz, ownerBoxFields, ownerSphFields, syncCarveBtn, measureToggle, updateMeasureReadout, reflectActiveMarker } from './edit-panel';
import { regMinX, regMinY, regMinZ, regMaxX, regMaxY, regMaxZ, regSphX, regSphY, regSphZ, regSphR, regionShadeEl, syncRegionViz, updateRegionEstimate } from './region-panel';
import { syncCollisionRows, seedX, seedY, seedZ, syncSeedViz, syncSeedPreview } from './collision-panel';
import './upload';
import './groups';
import './analyze-panel';
import { enableUndo } from './undo';
import './settings';
import './menubar';
import { loadProjects, PROJECT_KEY } from './projects';
import { onWorkspaceSwitched } from './workspace';
import { mcpHandlers } from './mcp-handlers';
import * as api from './api';
import { SplatViewer } from './viewer';
import { startMcpBridge } from './mcp-bridge';

// ---------- boot ----------
// keep the scene list fresh when tabs change (the capsule item depends on the
// Collision tab being visible) or the Scene tab is shown; the render frustum +
// camera-view preview are gated on the Render tab being the active one
dock.onDidActivePanelChange(() => { updateRenderFrustum(); rebuildSceneList(); syncSeedPreview(); });

// re-apply persisted form values, then re-run the row/label syncs that already
// fired at panel-module eval (i.e. before restore) so they reflect restored values
restoreFormState();
syncPresetRows(); // preset chips reflect the restored hidden selects
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
        syncSeedPreview(); // capsule preview if the Collision tab is already up
        // crop gizmo -> reflect into the OWNING panel's box/sphere fields (Convert crop
        // or Edit carve), live; persist on release
        v.onCropSphereMove = (c) => { const [x, y, z] = ownerSphFields(); x.value = String(c.x); y.value = String(c.y); z.value = String(c.z); };
        v.onCropBoxMove = (d) => {
            const shift = (el: HTMLInputElement, dv: number) => { if (el.value.trim() !== '') el.value = String(round(Number(el.value) + dv)); };
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
hooks.syncEditorStatus = syncEditorStatus; // workspace.ts re-syncs consent through this after a switch
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
