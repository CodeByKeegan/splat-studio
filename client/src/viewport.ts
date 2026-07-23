// Viewport chrome around the 3D view: layer visibility + toolbar controls,
// HUD chips, layer removal, the Scene hierarchy list, and the skybox picker.
// viewportCallbacks late-binds upward calls into files-panel / edit-panel.
import * as api from './api';
import type { SelId } from './viewer';
import { $, hudSplat, hudCollision, hudVoxel, skyboxSelect } from './dom';
import { viewer, layerVisible, setCurrentSplatName, setCurrentCollisionName, setCurrentVoxelName, hooks } from './state';
import type { LayerId } from './state';
import { showToast } from './ui';

// late-bound upward calls (files-panel / edit-panel / collision-panel assign their entries at eval)
export const viewportCallbacks: { updateFileEyes: () => void; syncActiveSplatChip: () => void; syncPreview: () => void; syncSeedPreview: () => void } = {
    updateFileEyes: () => {},
    syncActiveSplatChip: () => {},
    syncPreview: () => {},
    syncSeedPreview: () => {}
};

// chips carry a label span + a remove ✕; set/clear the label, not the chip itself
export const setChip = (chip: HTMLSpanElement, text: string) => {
    const label = chip.querySelector('.chip-label');
    if (label) label.textContent = text;
    chip.classList.remove('hidden');
};
export const hideChip = (chip: HTMLSpanElement) => {
    chip.classList.add('hidden');
    const label = chip.querySelector('.chip-label');
    if (label) label.textContent = '';
};

// ---------- viewport toolbar + settings ----------
// guards: handlers are live before the async viewer boot finishes
export function applyLayerVisible(id: LayerId): void {
    if (id === 'splat') viewer?.setSplatVisible(layerVisible.splat);
    else if (id === 'collision') viewer?.setCollisionVisible(layerVisible.collision);
    else viewer?.setVoxelsVisible(layerVisible.voxels);
}
export function toggleLayer(id: LayerId): void {
    layerVisible[id] = !layerVisible[id];
    applyLayerVisible(id);
    rebuildSceneList();
}
$<HTMLInputElement>('show-bounds').onchange = (e) =>
    viewer?.setBoundsVisible((e.currentTarget as HTMLInputElement).checked);
$<HTMLInputElement>('voxel-color').oninput = (e) =>
    viewer?.setVoxelColor((e.currentTarget as HTMLInputElement).value);
$<HTMLInputElement>('voxel-opacity').oninput = (e) =>
    viewer?.setVoxelOpacity(Number((e.currentTarget as HTMLInputElement).value));
$<HTMLInputElement>('wire-color').oninput = (e) =>
    viewer?.setWireColor((e.currentTarget as HTMLInputElement).value);
$<HTMLInputElement>('wire-opacity').oninput = (e) =>
    viewer?.setWireOpacity(Number((e.currentTarget as HTMLInputElement).value));

$<HTMLSelectElement>('collision-style').onchange = (e) =>
    viewer?.setCollisionStyle((e.currentTarget as HTMLSelectElement).value as 'xray' | 'hidden' | 'solid');
$<HTMLInputElement>('collision-flip').onchange = (e) =>
    viewer?.setCollisionFlipped((e.currentTarget as HTMLInputElement).checked);
$<HTMLButtonElement>('frame-scene').onclick = () => viewer?.frame();

// remove (unload) layers — distinct from the show/hide eyes above
export const removeSplat = (): void => {
    const n = viewer?.activeSplatName;
    if (n) viewer?.unloadFile(n); // the newest remaining shown file becomes active
    viewportCallbacks.syncActiveSplatChip();
    viewportCallbacks.syncPreview();
    rebuildSceneList();
    hooks.scheduleUndoCapture();
};
export const removeCollision = (): void => { viewer?.clearCollision(); setCurrentCollisionName(null); hideChip(hudCollision); rebuildSceneList(); };
export const removeVoxels = (): void => { viewer?.clearVoxels(); setCurrentVoxelName(null); hideChip(hudVoxel); rebuildSceneList(); };
export const clearViewport = (): void => {
    viewer?.clearAll();
    hideChip(hudSplat);
    hideChip(hudCollision);
    hideChip(hudVoxel);
    setCurrentSplatName(null);
    setCurrentCollisionName(null);
    setCurrentVoxelName(null);
    viewportCallbacks.syncPreview();
    rebuildSceneList();
};
hudSplat.querySelector('.chip-remove')?.addEventListener('click', removeSplat);
hudCollision.querySelector('.chip-remove')?.addEventListener('click', removeCollision);
hudVoxel.querySelector('.chip-remove')?.addEventListener('click', removeVoxels);
$<HTMLButtonElement>('clear-viewport').onclick = clearViewport;

// ---------- scene hierarchy panel ----------
$<HTMLSelectElement>('camera-mode').onchange = (e) =>
    viewer?.setCameraMode((e.currentTarget as HTMLSelectElement).value as 'fly' | 'orbit');

const sceneList = $<HTMLUListElement>('scene-list');
const camMoveBtn = $<HTMLButtonElement>('cam-move');
const camRotateBtn = $<HTMLButtonElement>('cam-rotate');
camMoveBtn.onclick = () => { viewer?.setCameraGizmoMode('move'); camMoveBtn.classList.add('active'); camRotateBtn.classList.remove('active'); };
camRotateBtn.onclick = () => { viewer?.setCameraGizmoMode('rotate'); camRotateBtn.classList.add('active'); camMoveBtn.classList.remove('active'); };

export const SCENE_ITEMS: { id: SelId; label: string; icon: string; gizmo: boolean; has: () => boolean }[] = [
    { id: 'splat', label: 'Splat', icon: '✨', gizmo: false, has: () => !!viewer?.hasSplat },
    { id: 'collision', label: 'Collision mesh', icon: '🧱', gizmo: false, has: () => !!viewer?.hasCollision },
    { id: 'voxels', label: 'Voxels', icon: '🧊', gizmo: false, has: () => !!viewer?.hasVoxels },
    // collision region box only while setting up collision (Collision tab + region on)
    // listed whenever their toggle is on (the box/sphere stays visible on other tabs, so the
    // selection + gizmo must survive tab switches too)
    { id: 'collision-region', label: 'Collision region box', icon: '⬚', gizmo: true, has: () => !!viewer?.hasSplat && $<HTMLInputElement>('region-box-on').checked },
    { id: 'collision-sphere', label: 'Collision region sphere', icon: '◯', gizmo: true, has: () => !!viewer?.hasSplat && $<HTMLInputElement>('region-sphere-on').checked },
    // seed + capsule: always selectable with a splat loaded — the Collision panel's
    // "Select & drag" button targets it, and it previews while the Collision tab is up
    { id: 'capsule', label: 'Seed / carve capsule', icon: '💊', gizmo: true, has: () => !!viewer?.hasSplat },
    // render camera only when a WebP render is actually being set up
    { id: 'render-camera', label: 'Render camera', icon: '🎥', gizmo: true, has: () => !!viewer?.hasRenderCamera }
];

// re-render the Scene hierarchy from what's currently loaded in the viewer
export function rebuildSceneList(): void {
    if (!viewer) return;
    // getting-started overlay lives while the viewport is empty
    $('viewport-welcome').classList.toggle('hidden', viewer.hasSplat || viewer.hasCollision || viewer.hasVoxels);
    const items = SCENE_ITEMS.filter((it) => it.has());
    // if the selected object is no longer listed (e.g. capsule when collision
    // hidden, render camera when leaving WebP), clear the selection + its gizmo
    if (viewer.selection !== 'none' && !items.some((it) => it.id === viewer!.selection)) {
        viewer.selectObject('none');
    }
    const sel = viewer.selection;
    sceneList.innerHTML = '';
    if (!items.length) {
        const li = document.createElement('li');
        li.className = 'scene-empty';
        li.textContent = 'Nothing loaded — view a splat to populate the scene.';
        sceneList.appendChild(li);
    }
    for (const it of items) {
        const li = document.createElement('li');
        li.className = 'scene-item' + (it.id === sel ? ' selected' : '');
        li.title = it.gizmo ? 'Select to move it with a gizmo' : 'Selecting hides any gizmo';
        const isLayer = it.id === 'splat' || it.id === 'collision' || it.id === 'voxels';
        const vis = isLayer ? layerVisible[it.id as LayerId] : true;
        const eye = isLayer ? `<button class="scene-eye${vis ? '' : ' off'}" title="Show / hide">${vis ? '👁' : '🙈'}</button>` : '<span class="scene-eye-spacer"></span>';
        const gizmo = it.gizmo ? '<span class="scene-gizmo" title="movable">✥</span>' : '';
        li.innerHTML = `${eye}<span class="scene-icon">${it.icon}</span><span class="scene-name">${it.label}</span>${gizmo}`;
        li.onclick = () => { selectScene(it.id === viewer!.selection ? 'none' : it.id); };
        if (isLayer) {
            li.querySelector('.scene-eye')?.addEventListener('click', (e) => { e.stopPropagation(); toggleLayer(it.id as LayerId); });
        }
        sceneList.appendChild(li);
    }
    $('cam-gizmo-mode').classList.toggle('hidden', sel !== 'render-camera');
    // the workflow panels' "Select & drag in viewport" buttons mirror the selection
    for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-sel]')) {
        b.classList.toggle('active', b.dataset.sel === sel);
    }
    viewportCallbacks.updateFileEyes(); // file-row eyes mirror the same visibility state
    viewportCallbacks.syncSeedPreview(); // capsule preview tracks splat presence + active tab
}

export function selectScene(id: SelId): void {
    viewer?.selectObject(id);
    rebuildSceneList();
}

// ---------- skybox (scene environment) ----------
$<HTMLButtonElement>('skybox-apply').onclick = () => {
    const name = skyboxSelect.value;
    if (!name) return showToast('Pick an image to use as the skybox', true);
    if (!viewer) return showToast('Viewer is still starting up', true);
    const btn = $<HTMLButtonElement>('skybox-apply');
    btn.disabled = true;
    showToast(`Loading skybox ${name.split('/').pop()}…`);
    void viewer.setSkybox(api.fileUrl(name), name.split('/').pop() ?? name)
        .then((ok) => { if (ok) showToast('Skybox applied'); })
        .catch((err) => showToast(`Failed to load skybox: ${err}`, true))
        .finally(() => { btn.disabled = false; });
};
$<HTMLButtonElement>('skybox-clear').onclick = () => { viewer?.clearSkybox(); showToast('Skybox cleared'); };
