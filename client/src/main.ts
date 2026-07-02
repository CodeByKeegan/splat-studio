import * as api from './api';
import { SplatViewer } from './viewer';
import type { SelId } from './viewer';
import { startMcpBridge, editorError } from './mcp-bridge';
import { createDockview, markDockviewPackageLoaded } from 'dockview-core';
import type { DockviewApi, IContentRenderer, ITabRenderer, TabPartInitParameters } from 'dockview-core';
import 'dockview-core/dist/styles/dockview.css';
markDockviewPackageLoaded(); // silence the "internal package" dev notice — we use the core directly on purpose

const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
};

const fileList = $<HTMLUListElement>('file-list');
const convertInput = $<HTMLSelectElement>('convert-input');
const lodInput = $<HTMLSelectElement>('lod-input');
const renderInput = $<HTMLSelectElement>('render-input');
const collisionInput = $<HTMLSelectElement>('collision-input');
const analyzeInput = $<HTMLSelectElement>('analyze-input');
const editInput = $<HTMLSelectElement>('edit-input');
const skyboxSelect = $<HTMLSelectElement>('skybox-select');
// per-layer visibility, toggled by the Scene panel's eye buttons (replaces the old checkboxes)
const layerVisible = { splat: true, collision: true, voxels: true };
type LayerId = keyof typeof layerVisible;
const toastStack = $<HTMLDivElement>('toast-stack');
const hudSplat = $<HTMLSpanElement>('hud-splat');
const hudCollision = $<HTMLSpanElement>('hud-collision');
const hudVoxel = $<HTMLSpanElement>('hud-voxel');
const jobTitle = $<HTMLSpanElement>('job-title');
const jobStatus = $<HTMLSpanElement>('job-status');
const jobCommand = $<HTMLElement>('job-command');
const jobLog = $<HTMLPreElement>('job-log');

let viewer: SplatViewer | undefined;

const showToast = (message: string, isError = false) => {
    const el = document.createElement('div');
    el.className = isError ? 'toast error' : 'toast';
    el.textContent = message;
    toastStack.appendChild(el);
    while (toastStack.children.length > 4) toastStack.firstChild?.remove();
    setTimeout(() => el.remove(), isError ? 8000 : 4000);
};

// In-app text prompt — Electron's renderer has no window.prompt(). Resolves the
// trimmed value, or null if cancelled.
const promptText = (title: string, opts: { value?: string; okLabel?: string; placeholder?: string } = {}): Promise<string | null> =>
    new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        const modal = document.createElement('div');
        modal.className = 'modal';
        const h = document.createElement('div');
        h.className = 'modal-title';
        h.textContent = title;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = opts.value ?? '';
        if (opts.placeholder) input.placeholder = opts.placeholder;
        const row = document.createElement('div');
        row.className = 'modal-row';
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        const ok = document.createElement('button');
        ok.className = 'primary';
        ok.textContent = opts.okLabel ?? 'OK';
        row.append(cancel, ok);
        modal.append(h, input, row);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        input.focus();
        input.select();

        let done = false;
        const close = (value: string | null): void => {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey, true);
            backdrop.remove();
            resolve(value);
        };
        const submit = (): void => close(input.value.trim() || null);
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== 'Enter' && e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            close(e.key === 'Enter' ? (input.value.trim() || null) : null);
        };
        document.addEventListener('keydown', onKey, true);
        backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(null); });
        cancel.onclick = () => close(null);
        ok.onclick = submit;
    });

const fmtSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

// ---------- persisted form state ----------
const FORM_KEY = 'splat-studio.form';
// selects whose options come from the workspace — restored after the file list loads
const FILE_SELECT_IDS = new Set(['convert-input', 'lod-input', 'render-input', 'collision-input', 'analyze-input', 'edit-input']);
const formState: Record<string, string | boolean> = (() => {
    try { return JSON.parse(localStorage.getItem(FORM_KEY) ?? '{}'); } catch { return {}; }
})();

// bound to document: panels live in separate dock groups now, so a single
// delegated listener survives any re-docking (change bubbles to document)
document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement) || !t.id) return;
    formState[t.id] = t instanceof HTMLInputElement && t.type === 'checkbox' ? t.checked : t.value;
    localStorage.setItem(FORM_KEY, JSON.stringify(formState));
    scheduleUndoCapture(); // record an undo step for this committed change
});

const restoreFormState = () => {
    for (const [id, value] of Object.entries(formState)) {
        if (FILE_SELECT_IDS.has(id)) continue;
        const el = document.getElementById(id);
        if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) continue;
        if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = value === true;
        else el.value = String(value);
    }
};

// ---------- file list ----------
let splatFileNames: string[] = [];
// the splat currently shown in the viewport — the live Convert preview only
// applies while this is the Convert input, so baked outputs aren't double-transformed
let currentSplatName: string | null = null;

const fillSelect = (select: HTMLSelectElement, names: string[]) => {
    const prev = select.value;
    select.innerHTML = '';
    if (names.length === 0 || !names.includes(prev)) {
        // never silently snap to the first file — a wrong input burns GPU minutes
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.disabled = true;
        placeholder.selected = true;
        placeholder.textContent = names.length === 0 ? '— no splat files in workspace —' : '— select input —';
        select.appendChild(placeholder);
    }
    for (const name of names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }
    if (names.includes(prev)) select.value = prev;
};

const refreshFiles = async (highlight?: Set<string>) => {
    const files = await api.listFiles();

    // anything the CLI can read (incl. .spz/.splat/.ksplat/.lcc/.lcc2), not just
    // what the engine can render; lod-meta.json is viewable but not a CLI input
    const splatFiles = files.filter((f) => f.kind === 'splat' && !f.name.endsWith('lod-meta.json'));
    splatFileNames = splatFiles.map((f) => f.name);
    // .mjs generators are valid convert/analyze inputs, but not collision/LOD sources
    const generatorNames = files.filter((f) => f.kind === 'generator').map((f) => f.name);
    const convertNames = [...splatFileNames, ...generatorNames];
    fillSelect(convertInput, convertNames);
    fillSelect(analyzeInput, convertNames);
    for (const select of [lodInput, renderInput, collisionInput, editInput, ...lodRowSelects()]) {
        fillSelect(select, splatFileNames);
    }
    // skybox picker: any image file in the project (equirect panorama)
    {
        const imgs = files.filter((f) => /\.(webp|jpe?g|png|hdr|avif)$/i.test(f.name)).map((f) => f.name);
        const prev = skyboxSelect.value;
        skyboxSelect.innerHTML = '';
        const none = document.createElement('option');
        none.value = ''; none.disabled = true; none.selected = true;
        none.textContent = imgs.length ? '— pick an image —' : '— no images in project —';
        skyboxSelect.appendChild(none);
        for (const n of imgs) {
            const o = document.createElement('option');
            o.value = n; o.textContent = n.split('/').pop() ?? n;
            if (n === prev) o.selected = true;
            skyboxSelect.appendChild(o);
        }
    }
    // re-apply the persisted choice once its file exists again
    for (const [select, id, names] of [
        [convertInput, 'convert-input', convertNames],
        [analyzeInput, 'analyze-input', convertNames],
        [lodInput, 'lod-input', splatFileNames],
        [renderInput, 'render-input', splatFileNames],
        [collisionInput, 'collision-input', splatFileNames],
        [editInput, 'edit-input', splatFileNames]
    ] as const) {
        const want = formState[id];
        if (!select.value && typeof want === 'string' && names.includes(want)) select.value = want;
    }
    updateInputRows();
    renderGroupMembers(new Set(checkedMembers())); // refresh the member list, keep ticks

    fileList.innerHTML = '';
    let firstNew: HTMLLIElement | null = null;
    for (const f of files) {
        // derive voxel viewability client-side too, so a server started before
        // this feature still gets the view button
        if (!f.viewable && f.name.endsWith('.voxel.json')) f.viewable = 'voxel';
        const li = document.createElement('li');
        if (highlight?.has(f.name)) {
            li.classList.add('new');
            firstNew ??= li;
        }

        const KIND_HINTS: Record<string, string> = {
            splat: 'Gaussian splat — usable as convert/collision input',
            lod: 'Streamed multi-LOD SOG — view streams chunks by camera distance; not usable as a conversion input',
            voxel: 'Sparse voxel octree (collision job output) — view it as translucent boxes, or use for runtime collision in supersplat-viewer',
            collision: 'Collision triangle mesh — view it as a wireframe over the splat',
            glb: 'glTF binary (KHR_gaussian_splatting splat export)',
            export: 'Export artifact (CSV / HTML / image)',
            generator: 'Procedural splat generator (.mjs) — pick as a Convert input and pass -p params (Beta, local only)',
            other: 'Unrecognized file type'
        };
        const tag = document.createElement('span');
        tag.className = `tag ${f.kind}`;
        tag.textContent = f.kind;
        tag.title = KIND_HINTS[f.kind] ?? f.kind;
        li.appendChild(tag);

        // keep the informative tail of long paths: the directory part ellipsizes first
        const name = document.createElement('span');
        name.className = 'name';
        name.title = f.name;
        const slash = f.name.lastIndexOf('/');
        if (slash >= 0) {
            const dir = document.createElement('span');
            dir.className = 'dir';
            dir.textContent = f.name.slice(0, slash + 1);
            const base = document.createElement('span');
            base.className = 'base';
            base.textContent = f.name.slice(slash + 1);
            name.append(dir, base);
        } else {
            const base = document.createElement('span');
            base.className = 'base';
            base.textContent = f.name;
            name.appendChild(base);
        }
        li.appendChild(name);

        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = fmtSize(f.size);
        li.appendChild(size);

        if (f.viewable) {
            const VIEW_HINTS: Record<string, string> = {
                splat: 'Load this splat in the 3D viewer (replaces the current splat)',
                collision: 'Overlay this collision mesh as a wireframe (replaces the current overlay)',
                voxel: 'Render the voxel octree as translucent boxes (replaces the current voxels)'
            };
            const view = document.createElement('button');
            view.textContent = 'view';
            view.title = VIEW_HINTS[f.viewable];
            view.onclick = () => void viewFile(f.name, f.viewable!);
            li.appendChild(view);
        } else {
            li.appendChild(document.createElement('span')); // keep ✕ in its grid column
        }

        // ⋯ actions button (and right-click anywhere on the row) → file menu
        const more = document.createElement('button');
        more.className = 'row-more';
        more.textContent = '⋯';
        more.title = 'Actions for this file (or right-click the row)';
        more.onclick = (e) => { e.stopPropagation(); const rect = more.getBoundingClientRect(); showContextMenu(rect.right, rect.bottom + 2, fileActions(f, files)); };
        li.appendChild(more);
        li.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(e.clientX, e.clientY, fileActions(f, files)); };

        // two-stage delete: first click arms, second click within 2.5s deletes
        const del = document.createElement('button');
        del.textContent = '✕';
        del.title = 'Delete from the workspace (for folder outputs, removes the whole folder). Click twice.';
        let disarmTimer: ReturnType<typeof setTimeout> | undefined;
        del.onclick = async () => {
            if (!del.classList.contains('armed')) {
                del.classList.add('armed');
                del.textContent = 'delete?';
                disarmTimer = setTimeout(() => {
                    del.classList.remove('armed');
                    del.textContent = '✕';
                }, 2500);
                return;
            }
            clearTimeout(disarmTimer);
            try {
                await api.deleteFile(f.name);
                await refreshFiles();
            } catch (err) {
                showToast(`Delete failed (${f.name}): ${err}`, true);
            }
        };
        li.appendChild(del);

        fileList.appendChild(li);
    }
    firstNew?.scrollIntoView({ block: 'nearest' });
};

// chips carry a label span + a remove ✕; set/clear the label, not the chip itself
const setChip = (chip: HTMLSpanElement, text: string) => {
    const label = chip.querySelector('.chip-label');
    if (label) label.textContent = text;
    chip.classList.remove('hidden');
};
const hideChip = (chip: HTMLSpanElement) => {
    chip.classList.add('hidden');
    const label = chip.querySelector('.chip-label');
    if (label) label.textContent = '';
};

const viewFile = async (name: string, as: api.ViewKind): Promise<boolean> => {
    const v = viewer;
    if (!v) { showToast('Viewer is still starting up', true); return false; }
    try {
        const url = api.fileUrl(name);
        const filename = name.split('/').pop()!;
        showToast(`Loading ${name}…`);
        if (as === 'splat') {
            if (!(await v.loadSplat(url, filename))) return false; // superseded by a newer load / remove
            setChip(hudSplat, `splat: ${name}`);
            layerVisible.splat = true;
            v.setSplatVisible(true);
            currentSplatName = name;
            syncPreview(); // apply the live Convert preview if this is the input
            syncRegionViz(); updateRegionEstimate(); // re-fit/recompute the region box for the new splat
        } else if (as === 'collision') {
            if (!(await v.loadCollision(url, filename))) return false;
            setChip(hudCollision, `collision: ${name} (${v.collisionTriangles.toLocaleString()} tris)`);
            layerVisible.collision = true;
            v.setCollisionVisible(true);
            // X-ray wireframe is unreadable on dense meshes — switch automatically
            const styleSelect = $<HTMLSelectElement>('collision-style');
            if (v.collisionTriangles > 100_000 && styleSelect.value === 'xray') {
                styleSelect.value = 'hidden';
                v.setCollisionStyle('hidden');
                showToast(`Dense mesh (${Math.round(v.collisionTriangles / 1000)}K tris) — switched to hidden-line wireframe. Try "Solid + edges" to check placement and carving.`);
            }
        } else {
            const { count, truncated, applied } = await v.loadVoxels(url);
            if (!applied) return false;
            setChip(hudVoxel, `voxels: ${name} (${count.toLocaleString()} boxes)`);
            layerVisible.voxels = true;
            v.setVoxelsVisible(true);
            if (truncated) {
                showToast(`Voxel display capped at ${count.toLocaleString()} boxes — regenerate with a coarser voxel size for full coverage`, true);
            }
        }
        rebuildSceneList();
        scheduleUndoCapture(); // loading a splat is an undo step
        return true;
    } catch (err) {
        showToast(`Failed to load ${name}: ${err}`, true);
        return false;
    }
};

// ---------- file context menu ----------
// A floating menu of every action that applies to a file — right-click a row or
// click its ⋯ button. Appended to <body> because dock panels are pooled /
// overflow-clipped, so a menu inside the panel would be cut off.
type CtxItem = 'sep' | { label: string; hint?: string; disabled?: boolean; danger?: boolean; run: () => void };

let ctxMenuEl: HTMLDivElement | null = null;
const closeContextMenu = (): void => {
    ctxMenuEl?.remove();
    ctxMenuEl = null;
    document.removeEventListener('pointerdown', onCtxOutside, true);
    document.removeEventListener('keydown', onCtxKey, true);
    document.removeEventListener('scroll', closeContextMenu, true);
    window.removeEventListener('blur', closeContextMenu);
    window.removeEventListener('resize', closeContextMenu);
};
function onCtxOutside(e: PointerEvent): void { if (ctxMenuEl && !ctxMenuEl.contains(e.target as Node)) closeContextMenu(); }
function onCtxKey(e: KeyboardEvent): void { if (e.key === 'Escape') closeContextMenu(); }

const showContextMenu = (x: number, y: number, items: CtxItem[]): void => {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    for (const it of items) {
        if (it === 'sep') { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
        const b = document.createElement('button');
        b.className = 'ctx-item' + (it.danger ? ' danger' : '');
        b.textContent = it.label;
        if (it.hint) b.title = it.hint;
        if (it.disabled) b.disabled = true;
        else b.onclick = () => { closeContextMenu(); it.run(); };
        menu.appendChild(b);
    }
    // measure off-screen, then clamp to the viewport
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - r.width - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - r.height - 6))}px`;
    menu.style.visibility = '';
    ctxMenuEl = menu;
    // defer the dismiss listeners so the opening click/right-click doesn't close it
    setTimeout(() => {
        document.addEventListener('pointerdown', onCtxOutside, true);
        document.addEventListener('keydown', onCtxKey, true);
        document.addEventListener('scroll', closeContextMenu, true);
        window.addEventListener('blur', closeContextMenu);
        window.addEventListener('resize', closeContextMenu);
    }, 0);
};

// focus (or open) a dock panel by id, and prefill a panel's input <select>
const openPanel = (id: string): void => { const w = winById(id); if (w) openWindow(w); };
const prefillSelect = (select: HTMLSelectElement, name: string): void => {
    select.value = name;
    select.dispatchEvent(new Event('change', { bubbles: true })); // refresh dependent rows + persist
};
const deleteFromMenu = (f: api.FileEntry): void => {
    const folder = f.name.includes('/') && (f.name.endsWith('meta.json') || f.name.endsWith('lod-meta.json'));
    if (!confirm(`Delete ${f.name}?${folder ? ' This removes the whole output folder.' : ''}`)) return;
    void api.deleteFile(f.name).then(() => refreshFiles()).catch((err) => showToast(`Delete failed (${f.name}): ${err}`, true));
};

// every action a given file supports, gated by its kind (mirrors fileKind on the server)
const fileActions = (f: api.FileEntry, all: api.FileEntry[]): CtxItem[] => {
    const items: CtxItem[] = [];
    const lower = f.name.toLowerCase();
    const isLod = f.kind === 'lod';
    const isGenerator = f.kind === 'generator';
    const isSplat = f.kind === 'splat' && !isLod;                 // .ply/.sog/.spz/.splat/.ksplat/.lcc/meta.json
    const isSog = isSplat && (lower.endsWith('.sog') || lower.endsWith('meta.json'));
    const isRaw = isSplat && !isSog;                              // an uncompressed source worth compressing to SOG

    if (f.viewable) items.push({ label: '👁  View in viewport', hint: 'Load this file into the 3D viewer', run: () => void viewFile(f.name, f.viewable!) });

    if (isGenerator) {
        items.push({ label: '✨  Generate & view', hint: 'Run the .mjs generator and load the result', run: () => { prefillSelect(convertInput, f.name); openPanel('panel-convert'); void updateInputRows().then(() => generateViewBtn.click()); } });
    }
    if (isRaw) {
        items.push({ label: 'Convert → SOG bundle', hint: 'Compress to a single .sog (~95% smaller)', run: () => { prefillSelect(convertInput, f.name); prefillSelect(convertFormat, 'sog'); openPanel('panel-convert'); } });
        items.push({ label: 'Convert → Streamed LOD', hint: 'Streamable multi-LOD SOG for big scenes', run: () => { prefillSelect(lodInput, f.name); openPanel('panel-lod'); } });
        items.push({ label: 'Render → WebP image', hint: 'Render a lossless image via the GPU rasterizer', run: () => { prefillSelect(renderInput, f.name); openPanel('panel-render'); } });
    }
    if (isSplat || isGenerator) {
        items.push({ label: isRaw ? 'Convert (other formats)…' : 'Convert…', hint: 'Open the Convert panel with this file selected', run: () => { prefillSelect(convertInput, f.name); openPanel('panel-convert'); } });
        items.push({ label: 'Analyze stats', hint: 'Run -m/--summary and show the stats card', run: () => { prefillSelect(analyzeInput, f.name); openPanel('panel-analyze'); analyzeRun.click(); } });
    }
    if (isSplat) {
        // collision output is a single canonical file per project (collision.collision.glb)
        const hasCollision = all.some((x) => x.name === 'collision.collision.glb');
        items.push({ label: hasCollision ? 'Regenerate collision…' : 'Generate collision…', hint: 'Open the Collision panel with this file selected', run: () => { prefillSelect(collisionInput, f.name); openPanel('panel-collision'); } });
        items.push({ label: 'Edit (scale / origin)…', hint: 'Measure to set real scale, or pick a new origin', run: () => { prefillSelect(editInput, f.name); if (f.viewable) void viewFile(f.name, f.viewable); openPanel('panel-edit'); } });
    }

    items.push('sep');
    items.push({ label: 'Copy file path', hint: f.name, run: () => void navigator.clipboard.writeText(f.name).then(() => showToast('Path copied')).catch(() => showToast('Copy failed', true)) });
    items.push({ label: 'Delete', danger: true, hint: 'Remove from the workspace', run: () => deleteFromMenu(f) });
    return items;
};

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
        await refreshFiles(); // files before the failure did land
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
        }
        updateInputRows();
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
// Convert it in Splat Studio with params like: width=16,height=16,scale=4
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

// ---------- jobs ----------
const jobCancel = $<HTMLButtonElement>('job-cancel');
const convertRun = $<HTMLButtonElement>('convert-run');
const lodRun = $<HTMLButtonElement>('lod-run');
const renderRun = $<HTMLButtonElement>('render-run');
const collisionRun = $<HTMLButtonElement>('collision-run');
const analyzeRun = $<HTMLButtonElement>('analyze-run');
// every run button is disabled together while a job runs (one GPU, one Job panel)
const RUN_BUTTONS = [convertRun, lodRun, renderRun, collisionRun, analyzeRun];
let activeJobId: string | null = null;

jobCancel.onclick = () => {
    if (activeJobId) void api.cancelJob(activeJobId).catch((err) => showToast(`Cancel failed: ${err}`, true));
};

/** every visible number input in the panel must hold a valid value */
const panelValid = (panelId: string): boolean => {
    for (const input of document.querySelectorAll<HTMLInputElement>(`#${panelId} input[type=number]`)) {
        if (input.closest('.hidden')) continue;
        if (!input.reportValidity()) return false;
    }
    return true;
};

// jobs are serialized: one GPU, one Job panel — and concurrent GPU jobs
// multiply the TDR risk
let jobBusy = false;
const runJob = async (start: () => Promise<string>, button: HTMLButtonElement, autoLoad = true): Promise<api.Job | undefined> => {
    const prevLabel = button.textContent;
    jobBusy = true;
    for (const b of RUN_BUTTONS) b.disabled = true;
    button.textContent = 'Running…';
    try {
        const jobId = await start();
        activeJobId = jobId;
        jobCancel.classList.remove('hidden');
        const job = await api.watchJob(jobId, (j) => {
            if (activeJobId !== jobId) return;
            jobTitle.textContent = j.title;
            jobStatus.textContent = j.status;
            jobStatus.className = `badge ${j.status}`;
            jobCommand.textContent = j.command;
            jobLog.textContent = j.log;
            jobLog.scrollTop = jobLog.scrollHeight;
            jobCancel.classList.toggle('hidden', j.status !== 'running');
        });
        await refreshFiles(new Set(job.outputs));
        if (job.status === 'done') {
            // load results into the viewer (when requested), then toast so 'done' stays visible
            if (autoLoad) {
                for (const v of job.viewables) {
                    await viewFile(v.name, v.as);
                }
            }
            showToast(job.outputs.length ? `${job.title} — done: ${job.outputs.join(', ')}` : `${job.title} — done`);
        } else if (/DEVICE_HUNG|device lost/i.test(job.log)) {
            showToast(`${job.title} — the GPU watchdog reset the device (TDR). On large scenes this is usually the cluster-filter pass: retry with "Filter to connected cluster" unchecked.`, true);
        } else {
            const lastLine = job.log.split('\n').map((l) => l.trim()).filter(Boolean).pop();
            showToast(`${job.title} — failed: ${lastLine?.slice(0, 160) ?? 'see the Job panel log'}`, true);
        }
        return job;
    } catch (err) {
        showToast(`Couldn't start job: ${err}`, true);
        return undefined;
    } finally {
        jobBusy = false;
        for (const b of RUN_BUTTONS) b.disabled = false;
        button.textContent = prevLabel;
        updateConvertRows(); // restores the format-specific Convert label
    }
};

// ---------- convert panel ----------
const convertFormat = $<HTMLSelectElement>('convert-format');
const lodMode = $<HTMLSelectElement>('lod-mode');
const lodFileRows = $<HTMLDivElement>('lod-file-rows');

const lodRowSelects = (): HTMLSelectElement[] => [...lodFileRows.querySelectorAll('select')];

const relabelLodRows = () => {
    let n = 1;
    [...lodFileRows.children].forEach((row) => {
        const label = row.querySelector('.lod-label');
        const isEnv = row.querySelector<HTMLInputElement>('.lod-env-box')?.checked;
        if (label) label.textContent = isEnv ? 'ENV' : `LOD ${n++}`;
    });
};

const addLodRow = () => {
    const row = document.createElement('div');
    row.className = 'lod-row';
    const label = document.createElement('span');
    label.className = 'lod-label';
    const select = document.createElement('select');
    select.title = 'File for this detail level — should hold fewer gaussians than the level above it';
    fillSelect(select, splatFileNames);
    // default to a file not already used by the input or another row
    const used = new Set([lodInput.value, ...lodRowSelects().map((s) => s.value)]);
    const free = splatFileNames.find((n) => !used.has(n));
    if (free) select.value = free;
    // optional environment tag: this file becomes an always-resident far/background
    // shell (-l -1) rather than a distance-streamed level. Only one row may be the
    // environment, so checking one clears the others.
    const env = document.createElement('label');
    env.className = 'lod-env';
    env.title = 'Environment level (-l -1): keep this file resident at all distances as a far/background shell — skybox, distant cityscape, forest — instead of streaming it by camera distance';
    const envBox = document.createElement('input');
    envBox.type = 'checkbox';
    envBox.className = 'lod-env-box';
    envBox.onchange = () => {
        if (envBox.checked) {
            lodFileRows.querySelectorAll<HTMLInputElement>('.lod-env-box').forEach((b) => { if (b !== envBox) b.checked = false; });
        }
        relabelLodRows();
    };
    env.append(envBox, document.createTextNode(' Env'));
    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.title = 'Remove this level';
    remove.onclick = () => {
        row.remove();
        relabelLodRows();
        updateLodRows(); // combine mode always keeps at least one row
    };
    row.append(label, select, env, remove);
    lodFileRows.appendChild(row);
    relabelLodRows();
};
$<HTMLButtonElement>('lod-add-level').onclick = addLodRow;

const RUN_LABELS: Record<string, string> = {
    'sog': 'Convert → SOG bundle',
    'sog-unbundled': 'Convert → SOG folder',
    'ply': 'Convert → PLY',
    'compressed-ply': 'Convert → Compressed PLY',
    'spz': 'Convert → SPZ',
    'glb': 'Convert → GLB',
    'csv': 'Convert → CSV',
    'html': 'Convert → HTML viewer'
};

const updateConvertRows = () => {
    const f = convertFormat.value;
    const isSog = f === 'sog' || f === 'sog-unbundled' || f === 'html';
    $('row-sog-encode').classList.toggle('hidden', !isSog);
    $('row-spz-version').classList.toggle('hidden', f !== 'spz');
    $('html-rows').classList.toggle('hidden', f !== 'html');
    if (!convertRun.disabled) convertRun.textContent = RUN_LABELS[f] ?? 'Convert';
};
convertFormat.onchange = updateConvertRows;

// LOD panel: decimate vs combine swaps which level controls show
const updateLodRows = () => {
    const combine = lodMode.value === 'combine';
    $('row-lod-levels').classList.toggle('hidden', combine);
    $('row-lod-files').classList.toggle('hidden', !combine);
    if (combine && lodFileRows.children.length === 0) addLodRow();
};
lodMode.onchange = updateLodRows;

// ----- LOD auto-tune: fill the LOD settings from each source's gaussian count + extents -----
const lodAutotuneBtn = $<HTMLButtonElement>('lod-autotune');
const lodAutotunePlan = $('lod-autotune-plan');
const baseLabel = (n: string): string => n.split('/').pop() ?? n;
const showLodPlan = (text: string, cls = ''): void => {
    lodAutotunePlan.textContent = text;
    lodAutotunePlan.className = `hint ${cls}`.trim();
};

// rebuild the combine rows from an ordered [{file, env}] list. No persistence
// needed: convertRun reads the rows live from the DOM at submit time.
const setCombineRows = (rows: { file: string; env: boolean }[]): void => {
    lodFileRows.innerHTML = '';
    for (const r of rows) {
        addLodRow();
        const row = lodFileRows.lastElementChild as HTMLElement;
        (row.querySelector('select') as HTMLSelectElement).value = r.file;
        (row.querySelector('.lod-env-box') as HTMLInputElement).checked = r.env;
    }
    relabelLodRows();
};

// single input → a decimation ladder sized to the gaussian count (and chunk
// extent to the scene size). All values clamped to the fields' min/max.
const autotuneDecimate = async (input: string): Promise<void> => {
    const s = await api.getStats(input);
    const maxExtent = Math.max(...s.extents.filter(Number.isFinite));
    const KEEP = 50, FLOOR = 150_000; // aim the coarsest level near ~150k gaussians
    let levels = 1;
    if (Number.isFinite(s.count) && s.count > FLOOR) {
        levels = Math.min(8, Math.max(2, 1 + Math.ceil(Math.log(FLOOR / s.count) / Math.log(KEEP / 100))));
    }
    const chunkExtent = Number.isFinite(maxExtent) ? Math.min(1000, Math.max(1, Math.round(maxExtent / 6))) : 16;
    const setNum = (id: string, v: number): void => { const el = $<HTMLInputElement>(id); el.value = String(v); el.dispatchEvent(new Event('change', { bubbles: true })); };
    setNum('lod-levels', levels);
    setNum('lod-keep', KEEP);
    setNum('lod-chunk-extent', chunkExtent);
    const ladder = Array.from({ length: levels }, (_, i) => fmtCount(Math.round(s.count * (KEEP / 100) ** i))).join(' → ');
    const sceneM = Number.isFinite(maxExtent) ? maxExtent.toFixed(1) : '?';
    showLodPlan(`Decimate ${fmtCount(s.count)} gaussians into ${levels} level${levels > 1 ? 's' : ''} at ${KEEP}% each: ${ladder}. Chunk extent ${chunkExtent} m (scene ≈ ${sceneM} m).`);
};

// combine mode → order the level rows by gaussian count (most detail first) and
// tag a backdrop (much larger extents, or an env/sky-ish name) as the environment.
const autotuneCombine = async (input: string): Promise<void> => {
    const candidates = [...new Set(lodRowSelects().map((s) => s.value).filter(Boolean))]
        .filter((f) => f !== input && !f.toLowerCase().endsWith('.mjs'))
        .slice(0, 8); // cap the fan-out — each candidate is one CPU summary
    if (!candidates.length) {
        showLodPlan('Add the LOD level files first (the Input is LOD 0), then Auto-tune to order them by gaussian count and tag a backdrop as the environment.', 'warn');
        return;
    }
    const [inputStats, ...rowStats] = await Promise.all([api.getStats(input), ...candidates.map((f) => api.getStats(f))]);
    const entries = candidates.map((file, i) => ({ file, count: rowStats[i].count, ext: Math.max(...rowStats[i].extents.filter(Number.isFinite)) }));
    const sortedExts = entries.map((e) => e.ext).sort((a, b) => a - b);
    const medianExt = sortedExts[Math.floor(sortedExts.length / 2)] || 1;
    const isEnv = (e: { file: string; ext: number }): boolean => /env|background|backdrop|sky/i.test(e.file) || e.ext > medianExt * 2.5;
    const env = entries.find(isEnv);
    const detail = entries.filter((e) => e !== env).sort((a, b) => b.count - a.count);
    setCombineRows([...detail.map((e) => ({ file: e.file, env: false })), ...(env ? [{ file: env.file, env: true }] : [])]);
    const plan = [`L0 = ${baseLabel(input)} (${fmtCount(inputStats.count)})`,
        ...detail.map((e, i) => `L${i + 1} = ${baseLabel(e.file)} (${fmtCount(e.count)})`),
        ...(env ? [`env = ${baseLabel(env.file)}`] : [])].join('  ·  ');
    const tooBig = entries.find((e) => Number.isFinite(inputStats.count) && e.count > inputStats.count);
    showLodPlan(plan, tooBig ? 'warn' : '');
    if (tooBig) showToast(`${baseLabel(tooBig.file)} has more gaussians than the Input — consider making it the Input (LOD 0).`, true);
};

lodAutotuneBtn.onclick = () => {
    const input = lodInput.value;
    if (!input) return showToast('Pick a LOD input first', true);
    if (input.toLowerCase().endsWith('.mjs')) return showToast('Auto-tune reads existing splats, not generators — convert the generator to a splat first', true);
    if (jobBusy) return showToast('A job is running — wait for it to finish', true);
    // mirror runJob's serialization (no server-side queue): block concurrent jobs
    jobBusy = true;
    for (const b of RUN_BUTTONS) b.disabled = true;
    lodAutotuneBtn.disabled = true;
    const prevLabel = lodAutotuneBtn.textContent;
    lodAutotuneBtn.textContent = 'Reading stats…';
    const run = lodMode.value === 'combine' ? autotuneCombine(input) : autotuneDecimate(input);
    void run.catch((err) => showToast(`Auto-tune failed: ${err}`, true))
        .finally(() => {
            jobBusy = false;
            for (const b of RUN_BUTTONS) b.disabled = false;
            lodAutotuneBtn.disabled = false;
            lodAutotuneBtn.textContent = prevLabel;
        });
};

// ----- generator + input-driven rows -----
// Keys off the selected INPUT (not the output format): a .mjs source → generator
// params (live sliders if the generator advertises a `params` schema, else a
// freeform field) + Generate & view; an .lcc source → LOD-select.
let genSchema: api.GenParam[] | null = null;
let genSchemaFor = '';
const generateViewBtn = $<HTMLButtonElement>('generate-view');

const renderGenSliders = (schema: api.GenParam[]) => {
    const container = $('gen-sliders');
    container.innerHTML = '';
    for (const p of schema) {
        const row = document.createElement('label');
        row.className = 'gen-slider';
        const label = document.createElement('span');
        label.className = 'gen-slider-label';
        label.textContent = p.label ?? p.name;
        const input = document.createElement('input');
        input.type = 'range';
        input.dataset.name = p.name;
        input.min = String(p.min ?? 0);
        input.max = String(p.max ?? 100);
        input.step = String(p.step ?? 1);
        input.value = String(p.default ?? p.min ?? 0);
        const val = document.createElement('span');
        val.className = 'gen-slider-val';
        val.textContent = input.value;
        input.oninput = () => { val.textContent = input.value; };
        input.onchange = scheduleGenPreview; // regenerate on release
        row.append(label, input, val);
        container.appendChild(row);
    }
};

const currentGenParams = (): string => {
    if (genSchema && genSchemaFor === convertInput.value) {
        return [...$('gen-sliders').querySelectorAll<HTMLInputElement>('input[type=range]')]
            .map((i) => `${i.dataset.name}=${i.value}`).join(',');
    }
    return $<HTMLInputElement>('convert-params').value.trim();
};

const updateInputRows = async (): Promise<void> => {
    const input = convertInput.value;
    const isMjs = input.toLowerCase().endsWith('.mjs');
    const lower = input.toLowerCase();
    $('row-lod-select').classList.toggle('hidden', !(lower.endsWith('.lcc') || lower.endsWith('.lcc2')));
    $('row-gen-actions').classList.toggle('hidden', !isMjs);
    if (!isMjs) {
        $('row-gen-params').classList.add('hidden');
        $('row-gen-sliders').classList.add('hidden');
        genSchema = null; genSchemaFor = '';
        return;
    }
    if (genSchemaFor !== input) {
        genSchemaFor = input;
        genSchema = await api.getGeneratorParams(input).catch(() => null);
        if (genSchema) renderGenSliders(genSchema);
    }
    const hasSchema = Array.isArray(genSchema) && genSchema.length > 0;
    $('row-gen-sliders').classList.toggle('hidden', !hasSchema);
    $('row-gen-params').classList.toggle('hidden', hasSchema);
};
convertInput.onchange = () => void updateInputRows();

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

// WebP: grab the viewer camera, converted to CLI render space
$<HTMLButtonElement>('webp-from-viewer').onclick = () => {
    if (!viewer) return showToast('Viewer is still starting up', true);
    const pose = viewer.cameraRenderPose();
    $<HTMLInputElement>('webp-camera').value = pose.camera;
    $<HTMLInputElement>('webp-lookat').value = pose.lookAt;
    updateRenderFrustum();
    showToast('Camera set from viewer — adjust if needed');
};

const strOrUndef = (id: string): string | undefined => {
    const v = $<HTMLInputElement>(id).value.trim();
    return v === '' ? undefined : v;
};
const numOrUndef = (id: string): number | undefined => {
    const v = $<HTMLInputElement>(id).value.trim();
    return v === '' ? undefined : Number(v);
};
const webpImageOptions = (): api.ImageOptions => ({
    camera: strOrUndef('webp-camera'),
    lookAt: strOrUndef('webp-lookat'),
    fov: numOrUndef('webp-fov'),
    resolution: strOrUndef('webp-resolution'),
    background: strOrUndef('webp-background'),
    projection: $<HTMLSelectElement>('webp-projection').value as 'pinhole' | 'equirect',
    fStop: numOrUndef('webp-fstop'),
    focusDistance: numOrUndef('webp-focus'),
    cameraEnd: strOrUndef('webp-cameraend'),
    shutter: numOrUndef('webp-shutter'),
    motionSamples: numOrUndef('webp-motionsamples')
});

// the Render panel is the shown tab in its group (gates the render frustum + camera view)
function renderActive(): boolean {
    const p = dock.getPanel('panel-render');
    return !!p && p.group.activePanel?.id === 'panel-render';
}

// show the WebP render camera as a frustum in the viewport while the Render tab is active
const updateRenderFrustum = (): void => {
    if (!viewer) return;
    const m = /^(\d+)x(\d+)$/i.exec($<HTMLInputElement>('webp-resolution').value.trim());
    const aspect = m ? Number(m[1]) / Number(m[2]) : 16 / 9;
    const equirect = $<HTMLSelectElement>('webp-projection').value === 'equirect';
    viewer.setRenderFrustum(
        $<HTMLInputElement>('webp-camera').value,
        $<HTMLInputElement>('webp-lookat').value,
        Number($<HTMLInputElement>('webp-fov').value),
        aspect,
        renderActive() && !equirect
    );
    refreshCameraViewHint(); // show/hide the Camera-view placeholder with the Render tab
};
for (const id of ['webp-camera', 'webp-lookat', 'webp-fov', 'webp-resolution', 'webp-projection']) {
    $(id).addEventListener('input', updateRenderFrustum);
    $(id).addEventListener('change', updateRenderFrustum);
}
// the render-camera scene item appears/disappears with the projection
$('webp-projection').addEventListener('change', () => rebuildSceneList());

const doGenerateView = (): void => {
    const input = convertInput.value;
    if (!input.toLowerCase().endsWith('.mjs')) { showToast('Pick a .mjs generator as the Convert input', true); return; }
    if (jobBusy) { scheduleGenPreview(); return; } // coalesce while a job runs
    void runJob(() => api.startConvert({ input, format: 'ply', options: { params: currentGenParams() } }), generateViewBtn);
};
let genPreviewTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleGenPreview(): void {
    clearTimeout(genPreviewTimer);
    genPreviewTimer = setTimeout(doGenerateView, 250);
}
generateViewBtn.onclick = doGenerateView;

restoreFormState();
updateConvertRows();
updateLodRows();
void updateInputRows();

// reveal each optional filter's inputs only when its checkbox is on
const ACTION_TOGGLES: [string, string][] = [
    ['filter-value-on', 'filter-value-rows'],
    ['filter-floaters-on', 'filter-floaters-rows'],
    ['region-box-on', 'region-box-rows'],
    ['region-sphere-on', 'region-sphere-rows']
];
const syncActionRows = () => {
    for (const [cb, rows] of ACTION_TOGGLES) $(rows).classList.toggle('hidden', !$<HTMLInputElement>(cb).checked);
};
for (const [cb] of ACTION_TOGGLES) $(cb).addEventListener('change', syncActionRows);
syncActionRows();

// ---------- live viewport preview (Edit transforms + region gizmos) ----------
const tfX = $<HTMLInputElement>('tf-translate-x'), tfY = $<HTMLInputElement>('tf-translate-y'), tfZ = $<HTMLInputElement>('tf-translate-z');
const rfX = $<HTMLInputElement>('tf-rotate-x'), rfY = $<HTMLInputElement>('tf-rotate-y'), rfZ = $<HTMLInputElement>('tf-rotate-z');
const tfScaleEl = $<HTMLInputElement>('tf-scale');

const numOrNull = (el: HTMLInputElement) => el.value.trim() === '' ? null : Number(el.value);

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
    editActive() && previewingEdit() && (ecBoxOn() || ecSphOn()) ? 'edit' : 'none';
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
    if (jobBusy) return showToast('A job is running — wait for it to finish', true);
    const mode = regionMode();
    const ask = mode === 'keep'
        ? `Keep only the gaussians inside the region from ${input} (crop)? This writes a new trimmed .ply — the source is left untouched.`
        : `Remove the gaussians inside the region from ${input} (carve)? This writes a new trimmed .ply — the source is left untouched.`;
    if (!confirm(ask)) return;
    void runJob(() => api.startTrim({ input, options: { mode, ...region } }), carveRemoveBtn);
};

// ---------- collision region box (viewport <-> Collision-panel fields) ----------
const regMinX = $<HTMLInputElement>('region-min-x'), regMinY = $<HTMLInputElement>('region-min-y'), regMinZ = $<HTMLInputElement>('region-min-z');
const regMaxX = $<HTMLInputElement>('region-max-x'), regMaxY = $<HTMLInputElement>('region-max-y'), regMaxZ = $<HTMLInputElement>('region-max-z');
const regionBoxOn = () => $<HTMLInputElement>('region-box-on').checked;

const syncRegionViz = () => {
    if (!viewer) return;
    viewer.setCollisionRegion(
        [numOrNull(regMinX), numOrNull(regMinY), numOrNull(regMinZ)],
        [numOrNull(regMaxX), numOrNull(regMaxY), numOrNull(regMaxZ)],
        regionBoxOn()
    );
    rebuildSceneList(); // the 'Collision region' item appears/disappears with the toggle
};

// first time it's switched on, fill the box with the whole-scene bounds so the user shrinks inward
const seedRegionDefaults = () => {
    const empty = [regMinX, regMinY, regMinZ, regMaxX, regMaxY, regMaxZ].every((el) => el.value.trim() === '');
    if (!empty) return;
    const b = viewer?.regionDefaultBounds();
    if (!b) return;
    regMinX.value = String(b.min[0]); regMinY.value = String(b.min[1]); regMinZ.value = String(b.min[2]);
    regMaxX.value = String(b.max[0]); regMaxY.value = String(b.max[1]); regMaxZ.value = String(b.max[2]);
};

for (const el of [regMinX, regMinY, regMinZ, regMaxX, regMaxY, regMaxZ]) el.addEventListener('input', syncRegionViz);
$('region-box-on').addEventListener('change', () => {
    if (regionBoxOn()) seedRegionDefaults();
    syncRegionViz();
    if (regionBoxOn()) viewer?.selectObject('collision-region'); // raise the gizmo immediately
    updateRegionEstimate();
});

// ---------- overflow estimate (advisory) ----------
// splat-transform's marching-cubes vertex dedup Map overflows V8's hard cap.
const MC_VERTEX_CAP = 16_777_216;
// risk proxy: in-box gaussians scaled by (0.05/voxelSize)^2 (finer voxels => more MC vertices).
// calibrated against the known failure — the whole 12.2M-gaussian Acropolis at 0.05 m overflowed.
let regionRiskLevel: 'ok' | 'warn' | 'danger' = 'ok';
const fmtCount = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
const regionVoxelSize = () => Math.max(Number($<HTMLInputElement>('voxel-size').value) || 0.05, 0.001);
const updateRegionEstimate = () => {
    const chip = $('region-estimate'), actions = $('region-estimate-actions');
    if (!viewer || !viewer.hasSplat || !regionBoxOn()) { regionRiskLevel = 'ok'; chip.classList.add('hidden'); actions.classList.add('hidden'); return; }
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
let regionEstTimer = 0;
const updateRegionEstimateDebounced = () => { clearTimeout(regionEstTimer); regionEstTimer = window.setTimeout(updateRegionEstimate, 200); };
for (const el of [regMinX, regMinY, regMinZ, regMaxX, regMaxY, regMaxZ]) el.addEventListener('input', updateRegionEstimateDebounced);
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

// the Convert-panel encode-time filter fields, applied on the Convert run
const convertFilterOptions = () => ({
    filterHarmonics: $<HTMLSelectElement>('convert-harmonics').value,
    filterValue: $<HTMLInputElement>('filter-value-on').checked
        ? { column: $<HTMLSelectElement>('fv-column').value, comparator: $<HTMLSelectElement>('fv-cmp').value, value: Number($<HTMLInputElement>('fv-value').value) }
        : undefined,
    filterFloaters: $<HTMLInputElement>('filter-floaters-on').checked
        ? { size: $<HTMLInputElement>('ff-size').value, opacity: $<HTMLInputElement>('ff-op').value, min: $<HTMLInputElement>('ff-min').value }
        : undefined,
    mortonOrder: $<HTMLInputElement>('convert-morton').checked
});

convertRun.onclick = () => {
    const input = convertInput.value;
    if (!input) return showToast('Pick an input file first', true);
    if (!panelValid('panel-convert')) return;
    void runJob(() => api.startConvert({
        input,
        format: convertFormat.value,
        options: {
            iterations: Number($<HTMLInputElement>('convert-iterations').value),
            maxWorkers: Number($<HTMLInputElement>('convert-max-workers').value),
            spzVersion: Number($<HTMLSelectElement>('convert-spz-version').value),
            decimate: $<HTMLInputElement>('convert-decimate').value.trim(),
            filterNaN: $<HTMLInputElement>('convert-filter-nan').checked,
            device: $<HTMLSelectElement>('convert-device').value,
            verbose: $<HTMLInputElement>('convert-verbose').checked,
            unbundled: $<HTMLInputElement>('convert-unbundled').checked,
            viewerSettings: $<HTMLInputElement>('convert-viewer-settings').value.trim(),
            lodSelect: $<HTMLInputElement>('convert-lod-select').value.trim(),
            ...convertFilterOptions(),
            params: currentGenParams()
        }
    }), convertRun, $<HTMLInputElement>('convert-autoload').checked);
};

// ---------- LOD panel: bake a streamed multi-LOD SOG ----------
lodRun.onclick = () => {
    const input = lodInput.value;
    if (!input) return showToast('Pick a LOD input first', true);
    if (!panelValid('panel-lod')) return;
    let lodFiles: string[] | undefined;
    let lodEnvFlags: boolean[] | undefined;
    if (lodMode.value === 'combine') {
        // build files + env flags from the same row order so they stay aligned 1:1
        const picked = [...lodFileRows.children]
            .map((r) => ({
                file: r.querySelector<HTMLSelectElement>('select')!.value,
                env: !!r.querySelector<HTMLInputElement>('.lod-env-box')?.checked
            }))
            .filter((p) => p.file);
        lodFiles = picked.map((p) => p.file);
        lodEnvFlags = picked.map((p) => p.env);
        if (lodFiles.length === 0) {
            return showToast('Add at least one LOD level file, or switch LOD source to decimate', true);
        }
        if (lodEnvFlags.every((e) => e)) {
            return showToast('Mark at least one row as a normal (non-environment) LOD level', true);
        }
        const chain = [input, ...lodFiles];
        if (new Set(chain).size !== chain.length) {
            return showToast('Input and each LOD level must be different files', true);
        }
    }
    void runJob(() => api.startConvert({
        input,
        format: 'lod',
        options: {
            iterations: Number($<HTMLInputElement>('lod-iterations').value),
            maxWorkers: Number($<HTMLInputElement>('lod-max-workers').value),
            device: $<HTMLSelectElement>('lod-device').value,
            lodLevels: Number($<HTMLInputElement>('lod-levels').value),
            lodKeepPercent: Number($<HTMLInputElement>('lod-keep').value),
            lodChunkCount: Number($<HTMLInputElement>('lod-chunk-count').value),
            lodChunkExtent: Number($<HTMLInputElement>('lod-chunk-extent').value),
            lodFiles,
            lodEnvFlags
        }
    }), lodRun, $<HTMLInputElement>('lod-autoload').checked);
};

// ---------- Render panel: render a WebP image ----------
renderRun.onclick = () => {
    const input = renderInput.value;
    if (!input) return showToast('Pick a file to render first', true);
    if (!panelValid('panel-render')) return;
    void runJob(() => api.startConvert({
        input,
        format: 'webp',
        options: {
            device: $<HTMLSelectElement>('render-device').value,
            image: webpImageOptions()
        }
    }), renderRun);
};

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

groupApplyBtn.onclick = async () => {
    const members = checkedMembers();
    if (!members.length) return showToast('Tick at least one member', true);
    if (jobBusy) return showToast('A job is running — wait for it to finish', true);
    if (!panelValid('panel-convert')) return;
    const format = convertFormat.value;
    if (format === 'csv') {
        return showToast('Pick a splat output format in the Convert panel (PLY / SOG / …) — CSV doesn’t carry these per-gaussian edits', true);
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
        // fan the Edit transform out to each member, sequentially (jobBusy + runJob serialize)
        const options = {
            ...editTransformOptions(),
            device: $<HTMLSelectElement>('convert-device').value
        };
        const outputs: string[] = [];
        for (const member of members) {
            const job = await runJob(() => api.startConvert({ input: member, format, options }), groupApplyBtn, false);
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
    if (jobBusy) return showToast('A job is running — wait for it to finish', true);
    const mode = regionMode();
    const verb = mode === 'keep' ? 'Crop (keep only inside the region)' : 'Carve (remove inside the region)';
    if (!confirm(`${verb} on ${members.length} member${members.length > 1 ? 's' : ''}? Each writes a new trimmed .ply — the sources are left untouched.`)) return;
    groupWarn.classList.add('hidden');
    groupApplyBtn.disabled = true;
    groupApplyRegionBtn.disabled = true; // claim both buttons for the run
    try {
        const outputs: string[] = [];
        for (const member of members) {
            const job = await runJob(() => api.startTrim({ input: member, options: { mode, ...region } }), groupApplyRegionBtn, false);
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

// parse the Markdown table the CLI's -m/--summary prints to stdout (job log)
const parseSummary = (log: string): { rowCount: number; rows: StatRow[] } | null => {
    const start = log.indexOf('# Summary');
    if (start < 0) return null;
    const block = log.slice(start);
    const rc = block.match(/Row Count:\*\*\s*(\d+)/);
    const rows: StatRow[] = [];
    for (const line of block.split('\n')) {
        if (!line.trim().startsWith('|')) continue;
        const c = line.split('|').slice(1, -1).map((s) => s.trim());
        if (c.length < 9 || c[0] === 'Column' || /^-+$/.test(c[0])) continue;
        rows.push({ col: c[0], min: c[1], max: c[2], median: c[3], mean: c[4], std: c[5], nans: c[6], infs: c[7], hist: c[8] });
    }
    return rows.length ? { rowCount: rc ? Number(rc[1]) : NaN, rows } : null;
};

const fmtNum = (s: string): string => {
    const n = Number(s);
    if (!Number.isFinite(n)) return s;
    if (n !== 0 && (Math.abs(n) >= 100000 || Math.abs(n) < 0.001)) return n.toPrecision(4);
    return String(Math.round(n * 1000) / 1000);
};

let lastSummaryMarkdown = '';
const renderSummaryCard = (name: string, log: string): void => {
    const result = $('analyze-result');
    const summary = parseSummary(log);
    if (!summary) { result.classList.add('hidden'); showToast('Could not parse summary output', true); return; }
    lastSummaryMarkdown = log.slice(log.indexOf('# Summary')).trim();
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
const carveBox = $<HTMLInputElement>('carve');
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
    if (regionBoxOn() && regionRiskLevel === 'danger' &&
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

// ---------- viewport toolbar + settings ----------
// guards: handlers are live before the async viewer boot finishes
function applyLayerVisible(id: LayerId): void {
    if (id === 'splat') viewer?.setSplatVisible(layerVisible.splat);
    else if (id === 'collision') viewer?.setCollisionVisible(layerVisible.collision);
    else viewer?.setVoxelsVisible(layerVisible.voxels);
}
function toggleLayer(id: LayerId): void {
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

// Settings ▸ About: component versions (PlayCanvas from the bundled engine, app + splat-transform from the server)
void (async () => {
    const set = (id: string, v: string | null | undefined) => { const el = $(id); el.textContent = v ? `v${v}` : 'unknown'; };
    set('ver-playcanvas', SplatViewer.engineVersion);
    try { const v = await api.getVersions(); set('ver-app', v.app); set('ver-splat-transform', v.splatTransform); }
    catch { set('ver-app', null); set('ver-splat-transform', null); }
})();
$<HTMLSelectElement>('collision-style').onchange = (e) =>
    viewer?.setCollisionStyle((e.currentTarget as HTMLSelectElement).value as 'xray' | 'hidden' | 'solid');
$<HTMLInputElement>('collision-flip').onchange = (e) =>
    viewer?.setCollisionFlipped((e.currentTarget as HTMLInputElement).checked);
$<HTMLButtonElement>('frame-scene').onclick = () => viewer?.frame();

// remove (unload) layers — distinct from the show/hide checkboxes above
const removeSplat = () => { viewer?.clearSplat(); hideChip(hudSplat); currentSplatName = null; syncPreview(); rebuildSceneList(); scheduleUndoCapture(); };
const removeCollision = () => { viewer?.clearCollision(); hideChip(hudCollision); rebuildSceneList(); };
const removeVoxels = () => { viewer?.clearVoxels(); hideChip(hudVoxel); rebuildSceneList(); };
hudSplat.querySelector('.chip-remove')?.addEventListener('click', removeSplat);
hudCollision.querySelector('.chip-remove')?.addEventListener('click', removeCollision);
hudVoxel.querySelector('.chip-remove')?.addEventListener('click', removeVoxels);
$<HTMLButtonElement>('clear-viewport').onclick = () => {
    viewer?.clearAll();
    hideChip(hudSplat);
    hideChip(hudCollision);
    hideChip(hudVoxel);
    currentSplatName = null;
    syncPreview();
    rebuildSceneList();
};

// ---------- scene hierarchy panel ----------
$<HTMLSelectElement>('camera-mode').onchange = (e) =>
    viewer?.setCameraMode((e.currentTarget as HTMLSelectElement).value as 'fly' | 'orbit');

const sceneList = $<HTMLUListElement>('scene-list');
const camMoveBtn = $<HTMLButtonElement>('cam-move');
const camRotateBtn = $<HTMLButtonElement>('cam-rotate');
camMoveBtn.onclick = () => { viewer?.setCameraGizmoMode('move'); camMoveBtn.classList.add('active'); camRotateBtn.classList.remove('active'); };
camRotateBtn.onclick = () => { viewer?.setCameraGizmoMode('rotate'); camRotateBtn.classList.add('active'); camMoveBtn.classList.remove('active'); };

const regionMoveBtn = $<HTMLButtonElement>('region-move');
const regionResizeBtn = $<HTMLButtonElement>('region-resize');
regionMoveBtn.onclick = () => { viewer?.setRegionGizmoMode('move'); regionMoveBtn.classList.add('active'); regionResizeBtn.classList.remove('active'); };
regionResizeBtn.onclick = () => { viewer?.setRegionGizmoMode('resize'); regionResizeBtn.classList.add('active'); regionMoveBtn.classList.remove('active'); };

// the Collision panel is "selected" when its tab is the shown one in its group
// (isVisible is always true under 'always', and isActive is the single globally
// focused panel — so compare the group's active tab)
function collisionActive(): boolean {
    const p = dock.getPanel('panel-collision');
    return !!p && p.group.activePanel?.id === 'panel-collision';
}
// the Edit panel is the shown tab in its group (gates the carve region viz)
function editActive(): boolean {
    const p = dock.getPanel('panel-edit');
    return !!p && p.group.activePanel?.id === 'panel-edit';
}

const SCENE_ITEMS: { id: SelId; label: string; icon: string; gizmo: boolean; has: () => boolean }[] = [
    { id: 'splat', label: 'Splat', icon: '✨', gizmo: false, has: () => !!viewer?.hasSplat },
    { id: 'collision', label: 'Collision mesh', icon: '🧱', gizmo: false, has: () => !!viewer?.hasCollision },
    { id: 'voxels', label: 'Voxels', icon: '🧊', gizmo: false, has: () => !!viewer?.hasVoxels },
    // collision region box only while setting up collision (Collision tab + region on)
    { id: 'collision-region', label: 'Collision region', icon: '⬚', gizmo: true, has: () => !!viewer?.hasSplat && collisionActive() && $<HTMLInputElement>('region-box-on').checked },
    // capsule only while actively setting up collision carving (Collision tab + carve on)
    { id: 'capsule', label: 'Carve capsule', icon: '💊', gizmo: true, has: () => !!viewer?.hasSplat && collisionActive() && carveBox.checked },
    // render camera only when a WebP render is actually being set up
    { id: 'render-camera', label: 'Render camera', icon: '🎥', gizmo: true, has: () => !!viewer?.hasRenderCamera }
];

function rebuildSceneList(): void {
    if (!viewer) return;
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
    $('region-gizmo-mode').classList.toggle('hidden', sel !== 'collision-region');
}

function selectScene(id: SelId): void {
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

// ---------- dockable layout (dockview) ----------
// Each panel + the viewport is an existing DOM node adopted by a dock component;
// dockview reparents the node (never recreates it), so the PlayCanvas canvas
// survives every dock/redock and tab switch. Built BEFORE the viewer boots so the
// canvas is already mounted in the visible dock.
// every dockable window: the panels, the 3D viewport, and (PR4) the camera view.
// component is the createComponent key; closable=false omits the tab close button.
type Win = { id: string; component: string; title: string; closable: boolean };
const WINDOWS: Win[] = [
    { id: 'panel-files', component: 'panel-files', title: 'Files', closable: true },
    { id: 'panel-convert', component: 'panel-convert', title: 'Convert', closable: true },
    { id: 'panel-lod', component: 'panel-lod', title: 'LOD', closable: true },
    { id: 'panel-render', component: 'panel-render', title: 'Render', closable: true },
    { id: 'panel-analyze', component: 'panel-analyze', title: 'Analyze', closable: true },
    { id: 'panel-edit', component: 'panel-edit', title: 'Edit', closable: true },
    { id: 'panel-collision', component: 'panel-collision', title: 'Collision', closable: true },
    { id: 'panel-scene', component: 'panel-scene', title: 'Scene', closable: true },
    { id: 'panel-settings', component: 'panel-settings', title: 'Settings', closable: true },
    { id: 'camera-view', component: 'camera-view', title: 'Camera view', closable: true },
    { id: 'viewer', component: 'viewer', title: 'Viewer 3D', closable: false },
    { id: 'panel-job', component: 'panel-job', title: 'Job', closable: false }
];
const winById = (id: string): Win | undefined => WINDOWS.find((w) => w.id === id);
const nodeOf = (component: string): HTMLElement => $(component === 'viewer' ? 'viewport' : component);

// Live "Camera view" dock panel: its own <canvas> driven by viewer.setupCameraView
// (a render-to-texture of the WebP render camera). Wired when the viewer is ready.
let cameraViewCanvas: HTMLCanvasElement | null = null;
let cameraViewHint: HTMLElement | null = null;
function refreshCameraViewHint(): void {
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

const dock: DockviewApi = createDockview($('dock'), {
    // 'always' keeps every panel's adopted DOM node mounted (hidden, not detached)
    // when its tab is inactive — so getElementById + bound handlers stay live and
    // the PlayCanvas canvas is never torn down.
    defaultRenderer: 'always',
    createComponent: (o) => (o.name === 'camera-view' ? new CameraViewPanel() : new AdoptPanel(nodeOf(o.name))),
    defaultTabComponent: 'app-tab',
    createTabComponent: (o) => (o.name === 'app-tab' ? new AppTab() : undefined)
});

const titleOf = (id: string): string => winById(id)?.title ?? id;

function applyDefaultLayout(): void {
    dock.clear();
    dock.addPanel({ id: 'viewer', component: 'viewer', title: 'Viewer 3D' });
    dock.addPanel({ id: 'panel-files', component: 'panel-files', title: 'Files', position: { referencePanel: 'viewer', direction: 'left' } });
    for (const id of ['panel-convert', 'panel-lod', 'panel-render', 'panel-analyze', 'panel-edit', 'panel-collision']) {
        dock.addPanel({ id, component: id, title: titleOf(id), position: { referencePanel: 'panel-files', direction: 'within' } });
    }
    dock.addPanel({ id: 'panel-scene', component: 'panel-scene', title: 'Scene', position: { referencePanel: 'viewer', direction: 'right' } });
    dock.addPanel({ id: 'panel-settings', component: 'panel-settings', title: titleOf('panel-settings'), position: { referencePanel: 'panel-scene', direction: 'within' } });
    dock.addPanel({ id: 'panel-job', component: 'panel-job', title: 'Job', position: { referencePanel: 'viewer', direction: 'below' } });
    // size the side/bottom groups so the 3D viewport keeps the bulk of the window
    dock.getPanel('panel-files')?.group.api.setSize({ width: 340 });
    dock.getPanel('panel-scene')?.group.api.setSize({ width: 300 });
    dock.getPanel('panel-job')?.group.api.setSize({ height: 180 });
    dock.getPanel('panel-files')?.api.setActive();
}

// open (or focus) a window; close removes its tab (the node returns to the pool)
function openWindow(w: Win): void {
    const existing = dock.getPanel(w.id);
    if (existing) { existing.api.setActive(); return; }
    dock.addPanel({ id: w.id, component: w.component, title: w.title });
}
function closeWindow(w: Win): void {
    if (!w.closable) return;
    const p = dock.getPanel(w.id);
    if (p) dock.removePanel(p);
}

applyDefaultLayout();
// keep the scene list fresh when tabs change (the capsule item depends on the
// Collision tab being visible) or the Scene tab is shown; the render frustum +
// camera-view preview are gated on the Render tab being the active one
dock.onDidActivePanelChange(() => { updateRenderFrustum(); rebuildSceneList(); });
(window as unknown as { __dock: DockviewApi }).__dock = dock; // debug handle

// ---------- top menu bar (Window / Layout) ----------
const LAYOUT_VERSION = 1;
let saveTimer: number | undefined;
const persistNow = (): void => { void api.saveLayout({ __v: LAYOUT_VERSION, dockview: dock.toJSON() as unknown as Record<string, unknown> }); };

type MenuItem = { label: string; checked?: boolean; disabled?: boolean; onClick: () => void };
function makeMenu(label: string, itemsFn: () => MenuItem[]): HTMLElement {
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
        makeMenu('Window', () => WINDOWS.map((w) => ({
            label: w.title,
            checked: !!dock.getPanel(w.id),
            onClick: () => { if (dock.getPanel(w.id)) { if (w.closable) closeWindow(w); else openWindow(w); } else openWindow(w); }
        }))),
        makeMenu('Layout', () => [
            { label: 'Reset to default', onClick: () => { applyDefaultLayout(); persistNow(); } },
            { label: 'Save layout', onClick: persistNow }
        ])
    );
}
buildMenuBar();

// the viewport toolbar's ⚙ opens (or focuses) the Settings tab
$<HTMLButtonElement>('open-settings').onclick = () => { const w = winById('panel-settings'); if (w) openWindow(w); };

// ---------- per-workspace layout persistence ----------
async function bootLayout(): Promise<void> {
    let saved: api.Layout | null = null;
    try { saved = await api.getLayout(); } catch { /* offline / first run → keep default */ }
    const s = saved as { __v?: number; dockview?: unknown } | null;
    if (s && s.__v === LAYOUT_VERSION && s.dockview) {
        try { dock.fromJSON(s.dockview as Parameters<DockviewApi['fromJSON']>[0]); }
        catch { applyDefaultLayout(); }
    }
    dock.onDidLayoutChange(() => { clearTimeout(saveTimer); saveTimer = window.setTimeout(persistNow, 400); });
}
void bootLayout();

// ---------- projects ----------
const projectSelect = $<HTMLSelectElement>('project-select');
const PROJECT_KEY = 'splat-studio.project';

const switchProject = async (name: string) => {
    api.setProject(name);
    projectSelect.value = name;
    localStorage.setItem(PROJECT_KEY, name);
    // loaded layers belong to the project we're leaving
    viewer?.clearAll();
    hideChip(hudSplat);
    hideChip(hudCollision);
    hideChip(hudVoxel);
    currentSplatName = null;
    syncPreview();
    await refreshFiles();
    await loadGroup(); // tick the saved group members for this project
    clearUndoHistory(); // undo history doesn't span a project switch
};

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
        viewer?.clearAll();
        hideChip(hudSplat);
        hideChip(hudCollision);
        hideChip(hudVoxel);
        currentSplatName = null;
        syncPreview();
        fileList.innerHTML = '';
        showToast('No projects yet — click "+ New" to create one', true);
        return;
    }
    await switchProject(projects.includes(preferred ?? '') ? preferred! : projects[0]);
};

projectSelect.onchange = () => void switchProject(projectSelect.value);

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
// projects (and the active project's files) load first; renderer comes up in parallel
void loadProjects(localStorage.getItem(PROJECT_KEY) ?? undefined)
    .catch((err) => showToast(`Can't reach the local server — projects unavailable (${err})`, true))
    .finally(enableUndo); // begin undo history once the initial project + files have loaded
void SplatViewer.create($<HTMLCanvasElement>('gs-canvas'))
    .then((v) => {
        viewer = v;
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
            // bubbles:true so the delegated form-state listener on #sidebar persists it
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
        v.setBoundsVisible($<HTMLInputElement>('show-bounds').checked);
        // live measure readout + active-marker highlight as points are clicked in
        v.onMeasureChange = (d) => { if (measureToggle.checked) updateMeasureReadout(d); };
        v.onActiveMarkerChange = (which) => reflectActiveMarker(which);
        v.onEditPlaced = () => updateMeasureReadout();
        // scene hierarchy: reflect selection changes, and let the render-camera
        // gizmo drive the WebP camera/look-at fields
        v.onSelectionChange = () => rebuildSceneList();
        v.onRenderCameraMove = (cam, look) => {
            $<HTMLInputElement>('webp-camera').value = `${cam.x},${cam.y},${cam.z}`;
            $<HTMLInputElement>('webp-lookat').value = `${look.x},${look.y},${look.z}`;
            updateRenderFrustum();
        };
        v.setCameraMode($<HTMLSelectElement>('camera-mode').value as 'fly' | 'orbit');
        if (cameraViewCanvas) v.setupCameraView(cameraViewCanvas); // a Camera-view panel opened before the viewer booted
        syncPreview(); // reflect restored Convert fields once the viewer is up
        syncRegionViz(); // reflect a restored collision region box
        updateRegionEstimate(); // and its overflow risk
        updateRenderFrustum(); // show the render frustum if the Render tab is active
        rebuildSceneList();
        (window as unknown as { __viewer: SplatViewer }).__viewer = v; // debug handle
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
            try { dock.fromJSON(layout as Parameters<DockviewApi['fromJSON']>[0]); persistNow(); }
            catch (e) { return editorError('bad-input', `invalid layout: ${(e as Error).message}`); }
            return { ok: true };
        }
        return editorError('bad-input', `unknown layout action "${action}"`);
    },
    load_into_viewport: async ({ action, file }) => {
        if (action === 'clear') { removeSplat(); removeCollision(); removeVoxels(); return { cleared: true }; }
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
        return {
            project: projectSelect.value || null,
            loadedSplat: currentSplatName,
            activePanels,
            selection: viewer?.selection ?? 'none',
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
            if (gizmoMode === 'move' || gizmoMode === 'resize') document.getElementById(gizmoMode === 'resize' ? 'region-resize' : 'region-move')?.click();
            return { region: 'collision_region' };
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
        if (action === 'undo') { if (!canUndo()) return editorError('bad-input', 'nothing to undo'); doUndo(); }
        else if (action === 'redo') { if (!canRedo()) return editorError('bad-input', 'nothing to redo'); doRedo(); }
        else if (action !== 'get') return editorError('bad-input', `unknown history action "${action}"`);
        return { canUndo: canUndo(), canRedo: canRedo() };
    },
    render_pose: ({ action, camera, lookAt }) => {
        if (action === 'get') return need(viewer?.cameraRenderPose(), 'no render pose available');
        if (action === 'set') {
            if (Array.isArray(camera)) setField('webp-camera', (camera as number[]).join(','));
            if (Array.isArray(lookAt)) setField('webp-lookat', (lookAt as number[]).join(','));
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
interface DesktopApi {
    pickFolder(defaultPath?: string): Promise<string | null>;
    persistWorkspace(path: string): Promise<void>;
    openWorkspace(): Promise<void>;
    onChooseWorkspace(cb: () => void): void;
}
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

// ---------- MCP consent toggle (Settings) + bridge startup ----------
const mcpControl = $<HTMLInputElement>('mcp-control');
const mcpStatusEl = $('mcp-status');
let mcpConnected = false; // last real bridge state, from onStatus
const updateMcpStatus = (connected: boolean): void => {
    mcpConnected = connected;
    mcpStatusEl.textContent = `Editor bridge: ${connected ? 'connected' : 'disconnected'} · control ${mcpControl.checked ? 'ON' : 'off'}`;
};
mcpControl.onchange = () => {
    void fetch('/api/editor/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: mcpControl.checked }) })
        .then(() => updateMcpStatus(mcpConnected)) // re-render the label; keep the real connection state
        .catch(() => showToast('Failed to update MCP consent', true));
};
// reconcile the consent checkbox + label with the server's enforced state — also
// re-run after a workspace switch (consent is per-workspace and resets on switch)
const syncEditorStatus = (): Promise<void> =>
    fetch('/api/editor/status').then((r) => r.json()).then((s) => { mcpControl.checked = !!s.controlEnabled; updateMcpStatus(!!s.connected); }).catch(() => { /* server not up yet */ });
void syncEditorStatus();

startMcpBridge({
    handlers: mcpHandlers,
    appVersion: '0.1.0',
    project: () => projectSelect.value || null,
    onEvent: (name) => {
        if (name === 'workspace-changed') void refreshFiles();
        else if (name === 'workspace-switched') void onWorkspaceSwitched();
    },
    onStatus: updateMcpStatus
});
