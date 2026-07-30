// Dockable window layout (dockview-core): the dock instance, window registry,
// panel adoption + tab renderers, default layout, per-workspace layout
// persistence, and the top-bar dropdown menu builder.
import { createDockview, markDockviewPackageLoaded } from 'dockview-core';
import type { DockviewApi, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core';
import 'dockview-core/dist/styles/dockview.css';
import * as api from './api';
import { $ } from './dom';
import { viewer } from './state';

markDockviewPackageLoaded(); // silence the "internal package" dev notice — we use the core directly on purpose

// Each panel + the viewport is an existing DOM node adopted by a dock component;
// dockview reparents the node (never recreates it), so the PlayCanvas canvas
// survives every dock/redock and tab switch. Built BEFORE the viewer boots so the
// canvas is already mounted in the visible dock.
// every dockable window: the panels, the 3D viewport, and the camera view.
// component is the createComponent key; closable=false omits the tab close button.
export type Win = { id: string; component: string; title: string; closable: boolean };
export const WINDOWS: Win[] = [
    { id: 'panel-files', component: 'panel-files', title: 'Files', closable: true },
    { id: 'panel-convert', component: 'panel-convert', title: 'Export', closable: true },
    { id: 'panel-generate', component: 'panel-generate', title: 'Generate', closable: true },
    { id: 'panel-lod', component: 'panel-lod', title: 'LOD', closable: true },
    { id: 'panel-render', component: 'panel-render', title: 'Render', closable: true },
    { id: 'panel-analyze', component: 'panel-analyze', title: 'Analyze', closable: true },
    { id: 'panel-edit', component: 'panel-edit', title: 'Edit', closable: true },
    { id: 'panel-collision', component: 'panel-collision', title: 'Collision', closable: true },
    { id: 'panel-scene', component: 'panel-scene', title: 'Scene', closable: true },
    { id: 'camera-view', component: 'camera-view', title: 'Camera view', closable: true },
    { id: 'viewer', component: 'viewer', title: 'Viewer 3D', closable: false },
    { id: 'panel-job', component: 'panel-job', title: 'Jobs', closable: false }
];
export const winById = (id: string): Win | undefined => WINDOWS.find((w) => w.id === id);
const nodeOf = (component: string): HTMLElement => $(component === 'viewer' ? 'viewport' : component);

// Live "Camera view" dock panel: its own <canvas> driven by viewer.setupCameraView
// (a render-to-texture of the WebP render camera). Wired when the viewer is ready.
let cameraViewCanvas: HTMLCanvasElement | null = null;
let cameraViewHint: HTMLElement | null = null;
export const getCameraViewCanvas = (): HTMLCanvasElement | null => cameraViewCanvas;
export function refreshCameraViewHint(): void {
    if (cameraViewHint) cameraViewHint.style.display = viewer?.hasRenderCamera ? 'none' : '';
}
class CameraViewPanel implements IContentRenderer {
    readonly element = document.createElement('div');
    private canvas = document.createElement('canvas');
    private hint = document.createElement('div');
    constructor() {
        this.element.className = 'camera-view-panel';
        this.canvas.className = 'camera-view-canvas';
        this.hint.className = 'camera-view-hint';
        this.hint.textContent = 'Open the Render tab and set a camera to preview the render here.';
        this.element.append(this.canvas, this.hint);
    }
    init(): void {
        cameraViewCanvas = this.canvas;
        cameraViewHint = this.hint;
        viewer?.setupCameraView(this.canvas); // if viewer isn't up yet, the init block wires it
        refreshCameraViewHint();
    }
    dispose(): void {
        if (cameraViewCanvas === this.canvas) { cameraViewCanvas = null; cameraViewHint = null; viewer?.teardownCameraView(); }
    }
}

// Adopts an existing DOM node as panel content. On dispose (tab closed) the node
// is returned to the hidden pool so getElementById still finds it for a reopen —
// the node (and the PlayCanvas canvas inside #viewport) is never destroyed.
class AdoptPanel implements IContentRenderer {
    readonly element: HTMLElement;
    constructor(node: HTMLElement) { this.element = node; }
    init(): void {}
    dispose(): void { document.getElementById('panel-pool')?.appendChild(this.element); }
}

// Tab renderer with a close button only for closable windows (3D viewer + Job
// are non-closable; everything else can be closed and reopened from the menu).
class AppTab implements ITabRenderer {
    readonly element = document.createElement('div');
    private content = document.createElement('div');
    private close = document.createElement('div');
    constructor() {
        this.element.className = 'dv-default-tab';
        this.content.className = 'dv-default-tab-content';
        this.close.className = 'dv-default-tab-action';
        this.close.textContent = '✕';
        this.element.append(this.content, this.close);
    }
    init(p: TabPartInitParameters): void {
        this.content.textContent = p.title ?? p.api.id;
        const closable = winById(p.api.id)?.closable !== false;
        this.close.style.display = closable ? '' : 'none';
        this.close.onclick = (e) => { e.stopPropagation(); p.api.close(); };
    }
}

export const dock: DockviewApi = createDockview($('dock'), {
    // 'always' keeps every panel's adopted DOM node mounted (hidden, not detached)
    // when its tab is inactive — so getElementById + bound handlers stay live and
    // the PlayCanvas canvas is never torn down.
    defaultRenderer: 'always',
    createComponent: (o) => (o.name === 'camera-view' ? new CameraViewPanel() : new AdoptPanel(nodeOf(o.name))),
    defaultTabComponent: 'app-tab',
    createTabComponent: (o) => (o.name === 'app-tab' ? new AppTab() : undefined)
});

const titleOf = (id: string): string => winById(id)?.title ?? id;

// reset the dock to the factory arrangement
export function applyDefaultLayout(): void {
    dock.clear();
    dock.addPanel({ id: 'viewer', component: 'viewer', title: titleOf('viewer') });
    dock.addPanel({ id: 'panel-files', component: 'panel-files', title: titleOf('panel-files'), position: { referencePanel: 'viewer', direction: 'left' } });
    for (const id of ['panel-convert', 'panel-generate', 'panel-lod', 'panel-render', 'panel-analyze', 'panel-edit', 'panel-collision']) {
        dock.addPanel({ id, component: id, title: titleOf(id), position: { referencePanel: 'panel-files', direction: 'within' } });
    }
    dock.addPanel({ id: 'panel-scene', component: 'panel-scene', title: titleOf('panel-scene'), position: { referencePanel: 'viewer', direction: 'right' } });
    dock.addPanel({ id: 'panel-job', component: 'panel-job', title: titleOf('panel-job'), position: { referencePanel: 'viewer', direction: 'below' } });
    // size the side/bottom groups so the 3D viewport keeps the bulk of the window
    dock.getPanel('panel-files')?.group.api.setSize({ width: 340 });
    dock.getPanel('panel-scene')?.group.api.setSize({ width: 300 });
    dock.getPanel('panel-job')?.group.api.setSize({ height: 180 });
    dock.getPanel('panel-files')?.api.setActive();
}

// a restored layout carries the tab titles it was saved with — re-apply the
// current names so renamed windows don't show stale titles
export function reconcilePanelTitles(): void {
    for (const p of dock.panels) p.api.setTitle(titleOf(p.id));
}

// open (or focus) a window; close removes its tab (the node returns to the pool)
export function openWindow(w: Win): void {
    const existing = dock.getPanel(w.id);
    if (existing) { existing.api.setActive(); return; }
    dock.addPanel({ id: w.id, component: w.component, title: w.title });
}
export function closeWindow(w: Win): void {
    if (!w.closable) return;
    const p = dock.getPanel(w.id);
    if (p) dock.removePanel(p);
}

// a panel is "selected" when its tab is the shown one in its dock group
// (isVisible is always true under 'always', and isActive is the single globally
// focused panel — so compare the group's active tab)
export function panelActive(id: string): boolean {
    const p = dock.getPanel(id);
    return !!p && p.group.activePanel?.id === id;
}

// ---------- per-workspace layout persistence ----------
const LAYOUT_VERSION = 2; // v1 layouts had a Settings dock panel (now a dialog)
let saveTimer: number | undefined;
export const persistNow = (): void => { void api.saveLayout({ __v: LAYOUT_VERSION, dockview: dock.toJSON() as unknown as Record<string, unknown> }); };
// debounced persist — layout changes arrive in bursts while dragging
export const schedulePersist = (): void => { clearTimeout(saveTimer); saveTimer = window.setTimeout(persistNow, 400); };

// restore the saved layout (falling back to the default) and start persisting
export async function bootLayout(): Promise<void> {
    let saved: api.Layout | null = null;
    try { saved = await api.getLayout(); } catch { /* offline / first run → keep default */ }
    const s = saved as { __v?: number; dockview?: unknown } | null;
    if (s && s.__v === LAYOUT_VERSION && s.dockview) {
        try { dock.fromJSON(s.dockview as Parameters<DockviewApi['fromJSON']>[0]); reconcilePanelTitles(); }
        catch { applyDefaultLayout(); }
    }
    dock.onDidLayoutChange(schedulePersist);
}

export type MenuItem = { label: string; checked?: boolean; disabled?: boolean; onClick: () => void };
// top-bar dropdown menu; items re-computed on every open
export function makeMenu(label: string, itemsFn: () => MenuItem[]): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'menu';
    const btn = document.createElement('button');
    btn.className = 'menu-btn';
    btn.textContent = label;
    const drop = document.createElement('div');
    drop.className = 'menu-drop hidden';
    wrap.append(btn, drop);
    const close = (): void => { drop.classList.add('hidden'); document.removeEventListener('pointerdown', onDoc, true); };
    const onDoc = (e: PointerEvent): void => { if (!wrap.contains(e.target as Node)) close(); };
    btn.onclick = () => {
        if (!drop.classList.contains('hidden')) { close(); return; }
        drop.innerHTML = '';
        for (const it of itemsFn()) {
            const row = document.createElement('button');
            row.className = 'menu-item';
            row.disabled = !!it.disabled;
            row.innerHTML = `<span class="menu-check">${it.checked ? '✓' : ''}</span><span>${it.label}</span>`;
            if (!it.disabled) row.onclick = () => { close(); it.onClick(); };
            drop.appendChild(row);
        }
        drop.classList.remove('hidden');
        document.addEventListener('pointerdown', onDoc, true);
    };
    return wrap;
}

applyDefaultLayout();
(window as unknown as { __dock: DockviewApi }).__dock = dock; // capture harness handle (scripts/capture-docs.mjs)
