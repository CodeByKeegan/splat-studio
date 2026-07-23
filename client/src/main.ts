// App shell: wires every panel (files, export, LOD, render, analyze, edit,
// collision, generate, jobs, settings) to the API and the 3D viewer, owns the
// dockable layout, app state, undo/redo, and the MCP editor-command handlers.
import './boot-theme'; // theme first — before any UI paints
import { $, projectSelect } from './dom';
import { viewer, setViewer, layerVisible, currentSplatName, hooks } from './state';
import type { LayerId } from './state';
import { showToast } from './ui';
import { formState, restoreFormState } from './form-state';
import { dock, WINDOWS, winById, openWindow, closeWindow, applyDefaultLayout, reconcilePanelTitles, getCameraViewCanvas, persistNow, bootLayout } from './dockview';
import { toggleLayer, clearViewport, SCENE_ITEMS, rebuildSceneList, selectScene } from './viewport';
import { refreshFiles, viewFile } from './files-panel';
import { ensureJobsPolling } from './jobs';
import { updateGenRows } from './generate-panel';
import { updateConvertRows, updateInputRows, syncActionRows } from './convert-panel';
import { updateLodRows } from './lod-panel';
import { vecFieldIds, writeVecField, updateRenderFrustum } from './render-panel';
import { syncPreview, syncCropViz, ownerBoxFields, ownerSphFields, syncCarveBtn, measureToggle, originToggle, updateMeasureReadout, reflectActiveMarker } from './edit-panel';
import { regMinX, regMinY, regMinZ, regMaxX, regMaxY, regMaxZ, regSphX, regSphY, regSphZ, regSphR, regionShadeEl, syncRegionViz, updateRegionEstimate } from './region-panel';
import { syncCollisionRows, seedX, seedY, seedZ, syncSeedViz } from './collision-panel';
import './upload';
import './groups';
import './analyze-panel';
import { canUndo, canRedo, doUndo, doRedo, enableUndo, isUndoApplying } from './undo';
import { isSettingsOpen, openSettings, closeSettings } from './settings';
import './menubar';
import { loadProjects, PROJECT_KEY } from './projects';
import { onWorkspaceSwitched } from './workspace';
import * as api from './api';
import { SplatViewer } from './viewer';
import type { SelId } from './viewer';
import { startMcpBridge, editorError } from './mcp-bridge';
import type { DockviewApi } from 'dockview-core';

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
        if (isSettingsOpen()) activePanels.push('panel-settings');
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
        if (action !== 'get' && isUndoApplying()) return editorError('bad-input', 'a previous undo/redo is still applying — retry in a moment');
        if (action === 'undo') { if (!canUndo()) return editorError('bad-input', 'nothing to undo'); doUndo(); }
        else if (action === 'redo') { if (!canRedo()) return editorError('bad-input', 'nothing to redo'); doRedo(); }
        else if (action !== 'get') return editorError('bad-input', `unknown history action "${action}"`);
        return { canUndo: canUndo(), canRedo: canRedo(), applying: isUndoApplying() };
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
