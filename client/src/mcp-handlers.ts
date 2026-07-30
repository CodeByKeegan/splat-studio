// MCP editor-command dispatch: handlers set form fields + dispatch input/change
// (or drive the real GUI click paths) so gizmos, panel fields, and persisted
// form state update together. No top-level side effects.
import * as api from './api';
import { $, projectSelect } from './dom';
import { viewer, currentSplatName, layerVisible } from './state';
import type { LayerId } from './state';
import { dock, WINDOWS, winById, openWindow, closeWindow, applyDefaultLayout, reconcilePanelTitles, persistNow } from './dockview';
import { toggleLayer, clearViewport, SCENE_ITEMS, selectScene } from './viewport';
import { viewFile } from './files-panel';
import { vecFieldIds } from './render-panel';
import { measureToggle, originToggle } from './edit-panel';
import { canUndo, canRedo, doUndo, doRedo, isUndoApplying } from './undo';
import { isSettingsOpen, openSettings, closeSettings } from './settings';
import { editorError } from './mcp-bridge';
import type { SelId } from './viewer';
import type { DockviewApi } from 'dockview-core';

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

export const mcpHandlers: Record<string, (p: Record<string, unknown>) => unknown> = {
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
