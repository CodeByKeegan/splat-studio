import * as api from './api';
import { SplatViewer } from './viewer';
import type { SelId } from './viewer';
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

const fmtSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

// ---------- persisted form state ----------
const FORM_KEY = 'splat-studio.form';
// selects whose options come from the workspace — restored after the file list loads
const FILE_SELECT_IDS = new Set(['convert-input', 'collision-input', 'analyze-input', 'edit-input']);
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
    for (const select of [collisionInput, editInput, ...lodRowSelects()]) {
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

const viewFile = async (name: string, as: api.ViewKind) => {
    const v = viewer;
    if (!v) return showToast('Viewer is still starting up', true);
    try {
        const url = api.fileUrl(name);
        const filename = name.split('/').pop()!;
        showToast(`Loading ${name}…`);
        if (as === 'splat') {
            if (!(await v.loadSplat(url, filename))) return; // superseded by a newer load / remove
            setChip(hudSplat, `splat: ${name}`);
            layerVisible.splat = true;
            v.setSplatVisible(true);
            currentSplatName = name;
            syncPreview(); // apply the live Convert preview if this is the input
            syncRegionViz(); updateRegionEstimate(); // re-fit/recompute the region box for the new splat
        } else if (as === 'collision') {
            if (!(await v.loadCollision(url, filename))) return;
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
            if (!applied) return;
            setChip(hudVoxel, `voxels: ${name} (${count.toLocaleString()} boxes)`);
            layerVisible.voxels = true;
            v.setVoxelsVisible(true);
            if (truncated) {
                showToast(`Voxel display capped at ${count.toLocaleString()} boxes — regenerate with a coarser voxel size for full coverage`, true);
            }
        }
        rebuildSceneList();
    } catch (err) {
        showToast(`Failed to load ${name}: ${err}`, true);
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
        items.push({ label: 'Convert → Streamed LOD', hint: 'Streamable multi-LOD SOG for big scenes', run: () => { prefillSelect(convertInput, f.name); prefillSelect(convertFormat, 'lod'); openPanel('panel-convert'); } });
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
const collisionRun = $<HTMLButtonElement>('collision-run');
const analyzeRun = $<HTMLButtonElement>('analyze-run');
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
    convertRun.disabled = true;
    collisionRun.disabled = true;
    analyzeRun.disabled = true;
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
        convertRun.disabled = false;
        collisionRun.disabled = false;
        analyzeRun.disabled = false;
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
    const used = new Set([convertInput.value, ...lodRowSelects().map((s) => s.value)]);
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
        updateConvertRows(); // combine mode always keeps at least one row
    };
    row.append(label, select, env, remove);
    lodFileRows.appendChild(row);
    relabelLodRows();
};
$<HTMLButtonElement>('lod-add-level').onclick = addLodRow;

const RUN_LABELS: Record<string, string> = {
    'sog': 'Convert → SOG bundle',
    'sog-unbundled': 'Convert → SOG folder',
    'lod': 'Convert → Streamed LOD',
    'ply': 'Convert → PLY',
    'compressed-ply': 'Convert → Compressed PLY',
    'spz': 'Convert → SPZ',
    'glb': 'Convert → GLB',
    'csv': 'Convert → CSV',
    'html': 'Convert → HTML viewer',
    'webp': 'Render → WebP'
};

const updateConvertRows = () => {
    const f = convertFormat.value;
    const isLod = f === 'lod';
    const isWebp = f === 'webp';
    const combine = lodMode.value === 'combine';
    const isSog = f === 'sog' || f === 'sog-unbundled' || f === 'html' || isLod;
    $('row-sog-encode').classList.toggle('hidden', !isSog);
    $('row-spz-version').classList.toggle('hidden', f !== 'spz');
    $('row-decimate').classList.toggle('hidden', isLod || isWebp); // no decimate for LOD/render
    $('convert-actions').classList.toggle('hidden', isLod); // transforms/filters don't apply to LOD bakes
    $('row-lod-mode').classList.toggle('hidden', !isLod);
    $('row-lod-levels').classList.toggle('hidden', !isLod || combine);
    $('row-lod-files').classList.toggle('hidden', !isLod || !combine);
    $('row-lod-chunks').classList.toggle('hidden', !isLod);
    $('row-lod-autotune').classList.toggle('hidden', !isLod);
    if (!isLod) $('lod-autotune-plan').classList.add('hidden');
    $('html-rows').classList.toggle('hidden', f !== 'html');
    $('webp-rows').classList.toggle('hidden', !isWebp);
    if (isLod && combine && lodFileRows.children.length === 0) addLodRow();
    if (!convertRun.disabled) convertRun.textContent = RUN_LABELS[f] ?? 'Convert';
};
convertFormat.onchange = updateConvertRows;
lodMode.onchange = updateConvertRows;

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
    const input = convertInput.value;
    if (!input) return showToast('Pick a Convert input first', true);
    if (input.toLowerCase().endsWith('.mjs')) return showToast('Auto-tune reads existing splats, not generators — convert the generator to a splat first', true);
    if (jobBusy) return showToast('A job is running — wait for it to finish', true);
    // mirror runJob's serialization (no server-side queue): block concurrent jobs
    jobBusy = true;
    convertRun.disabled = true; collisionRun.disabled = true; analyzeRun.disabled = true;
    lodAutotuneBtn.disabled = true;
    const prevLabel = lodAutotuneBtn.textContent;
    lodAutotuneBtn.textContent = 'Reading stats…';
    const run = lodMode.value === 'combine' ? autotuneCombine(input) : autotuneDecimate(input);
    void run.catch((err) => showToast(`Auto-tune failed: ${err}`, true))
        .finally(() => {
            jobBusy = false;
            convertRun.disabled = false; collisionRun.disabled = false; analyzeRun.disabled = false;
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

// populate the device dropdown with GPU adapters (-L), then reapply any saved choice
void api.listGpus().then((gpus) => {
    const sel = $<HTMLSelectElement>('convert-device');
    for (const g of gpus) {
        const opt = document.createElement('option');
        opt.value = String(g.index);
        opt.textContent = `GPU ${g.index}: ${g.name}`;
        sel.appendChild(opt);
    }
    const want = formState['convert-device'];
    if (typeof want === 'string' && [...sel.options].some((o) => o.value === want)) sel.value = want;
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

// show the WebP render camera as a frustum in the viewport while WebP is selected
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
        convertFormat.value === 'webp' && !equirect
    );
    refreshCameraViewHint(); // show/hide the Camera-view placeholder with WebP mode
};
for (const id of ['webp-camera', 'webp-lookat', 'webp-fov', 'webp-resolution', 'webp-projection']) {
    $(id).addEventListener('input', updateRenderFrustum);
    $(id).addEventListener('change', updateRenderFrustum);
}
convertFormat.addEventListener('change', updateRenderFrustum);
// the render-camera scene item appears/disappears with the format/projection
convertFormat.addEventListener('change', () => rebuildSceneList());
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
void updateInputRows();

// reveal each optional filter's inputs only when its checkbox is on
const ACTION_TOGGLES: [string, string][] = [
    ['filter-box-on', 'filter-box-rows'],
    ['filter-sphere-on', 'filter-sphere-rows'],
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

// ---------- live viewport preview (Convert transforms + crop gizmos) ----------
const tfX = $<HTMLInputElement>('tf-translate-x'), tfY = $<HTMLInputElement>('tf-translate-y'), tfZ = $<HTMLInputElement>('tf-translate-z');
const rfX = $<HTMLInputElement>('tf-rotate-x'), rfY = $<HTMLInputElement>('tf-rotate-y'), rfZ = $<HTMLInputElement>('tf-rotate-z');
const tfScaleEl = $<HTMLInputElement>('tf-scale');
const boxMinX = $<HTMLInputElement>('box-min-x'), boxMinY = $<HTMLInputElement>('box-min-y'), boxMinZ = $<HTMLInputElement>('box-min-z');
const boxMaxX = $<HTMLInputElement>('box-max-x'), boxMaxY = $<HTMLInputElement>('box-max-y'), boxMaxZ = $<HTMLInputElement>('box-max-z');
const sphX = $<HTMLInputElement>('sphere-x'), sphY = $<HTMLInputElement>('sphere-y'), sphZ = $<HTMLInputElement>('sphere-z'), sphR = $<HTMLInputElement>('sphere-r');

// preview only while the displayed splat is the Convert input, and not for LOD output
const previewingInput = () => convertFormat.value !== 'lod' && currentSplatName !== null && currentSplatName === convertInput.value;
const numOrNull = (el: HTMLInputElement) => el.value.trim() === '' ? null : Number(el.value);

const syncSplatXform = () => {
    if (!viewer) return;
    if (!previewingInput()) { viewer.setSplatPreviewTransform(null, [0, 0, 0], 1); return; }
    viewer.setSplatPreviewTransform(
        [Number(tfX.value), Number(tfY.value), Number(tfZ.value)],
        [Number(rfX.value), Number(rfY.value), Number(rfZ.value)],
        Number(tfScaleEl.value)
    );
};

// ----- Edit-panel "Carve out region" fields (its own box/sphere, separate from the
// Convert crop filter) -----
const ecBoxMinX = $<HTMLInputElement>('carve-box-min-x'), ecBoxMinY = $<HTMLInputElement>('carve-box-min-y'), ecBoxMinZ = $<HTMLInputElement>('carve-box-min-z');
const ecBoxMaxX = $<HTMLInputElement>('carve-box-max-x'), ecBoxMaxY = $<HTMLInputElement>('carve-box-max-y'), ecBoxMaxZ = $<HTMLInputElement>('carve-box-max-z');
const ecSphX = $<HTMLInputElement>('carve-sphere-x'), ecSphY = $<HTMLInputElement>('carve-sphere-y'), ecSphZ = $<HTMLInputElement>('carve-sphere-z'), ecSphR = $<HTMLInputElement>('carve-sphere-r');
const cvBoxOn = () => $<HTMLInputElement>('filter-box-on').checked;
const cvSphOn = () => $<HTMLInputElement>('filter-sphere-on').checked;
const ecBoxOn = () => $<HTMLInputElement>('carve-box-on').checked;
const ecSphOn = () => $<HTMLInputElement>('carve-sphere-on').checked;
const previewingEdit = () => currentSplatName !== null && currentSplatName === editInput.value;

// The viewport crop box/sphere is shared by the Convert crop filter (keep inside)
// and the Edit carve (remove inside). The active panel + its enabled region decides
// who drives — and who the gizmo writes back to.
type CropOwner = 'edit' | 'convert' | 'none';
const cropOwner = (): CropOwner => {
    if (editActive() && previewingEdit() && (ecBoxOn() || ecSphOn())) return 'edit';
    if (previewingInput() && (cvBoxOn() || cvSphOn())) return 'convert';
    return 'none';
};
const ownerBoxFields = (): HTMLInputElement[] => cropOwner() === 'edit'
    ? [ecBoxMinX, ecBoxMinY, ecBoxMinZ, ecBoxMaxX, ecBoxMaxY, ecBoxMaxZ]
    : [boxMinX, boxMinY, boxMinZ, boxMaxX, boxMaxY, boxMaxZ];
const ownerSphFields = (): HTMLInputElement[] => cropOwner() === 'edit' ? [ecSphX, ecSphY, ecSphZ, ecSphR] : [sphX, sphY, sphZ, sphR];

const syncCropViz = () => {
    if (!viewer) return;
    const owner = cropOwner();
    if (owner === 'edit') {
        viewer.setCropBox([numOrNull(ecBoxMinX), numOrNull(ecBoxMinY), numOrNull(ecBoxMinZ)], [numOrNull(ecBoxMaxX), numOrNull(ecBoxMaxY), numOrNull(ecBoxMaxZ)], ecBoxOn());
        viewer.setCropSphere([Number(ecSphX.value), Number(ecSphY.value), Number(ecSphZ.value)], Number(ecSphR.value), ecSphOn());
    } else if (owner === 'convert') {
        viewer.setCropBox([numOrNull(boxMinX), numOrNull(boxMinY), numOrNull(boxMinZ)], [numOrNull(boxMaxX), numOrNull(boxMaxY), numOrNull(boxMaxZ)], cvBoxOn());
        viewer.setCropSphere([Number(sphX.value), Number(sphY.value), Number(sphZ.value)], Number(sphR.value), cvSphOn());
    } else {
        viewer.setCropBox([null, null, null], [null, null, null], false);
        viewer.setCropSphere([0, 0, 0], 0, false);
    }
    updateCarveCountDebounced();
};

const syncPreview = () => { syncSplatXform(); syncCropViz(); };

for (const el of [tfX, tfY, tfZ, rfX, rfY, rfZ, tfScaleEl]) el.addEventListener('input', syncSplatXform);
for (const el of [boxMinX, boxMinY, boxMinZ, boxMaxX, boxMaxY, boxMaxZ, sphX, sphY, sphZ, sphR,
    ecBoxMinX, ecBoxMinY, ecBoxMinZ, ecBoxMaxX, ecBoxMaxY, ecBoxMaxZ, ecSphX, ecSphY, ecSphZ, ecSphR]) el.addEventListener('input', syncCropViz);
for (const id of ['filter-box-on', 'filter-sphere-on', 'carve-box-on', 'carve-sphere-on']) $(id).addEventListener('change', syncCropViz);
convertInput.addEventListener('change', syncPreview);
convertFormat.addEventListener('change', syncPreview);
editInput.addEventListener('change', syncCropViz);
// reveal each carve region's fields only when its checkbox is on
for (const [cb, rows] of [['carve-box-on', 'carve-box-rows'], ['carve-sphere-on', 'carve-sphere-rows']] as const) {
    $(cb).addEventListener('change', () => $(rows).classList.toggle('hidden', !$<HTMLInputElement>(cb).checked));
}

// ----- carve out a region (Edit panel) → a trimmed .ply -----
// The CLI's -B/-S only KEEP inside, so removal runs a local Node trim (server/ply-trim.mjs).
const carveRemoveBtn = $<HTMLButtonElement>('carve-remove');
const carveCount = $<HTMLDivElement>('carve-count');
const carveRegion = (): { box?: string[]; sphere?: [number, number, number, number] } | null => {
    const box = ecBoxOn() ? [ecBoxMinX.value, ecBoxMinY.value, ecBoxMinZ.value, ecBoxMaxX.value, ecBoxMaxY.value, ecBoxMaxZ.value] : undefined;
    const sphere = ecSphOn() ? [Number(ecSphX.value), Number(ecSphY.value), Number(ecSphZ.value), Number(ecSphR.value)] as [number, number, number, number] : undefined;
    return box || sphere ? { box, sphere } : null;
};
const syncCarveBtn = (): void => { carveRemoveBtn.disabled = !carveRegion(); };
function updateCarveCount(): void {
    if (!viewer || cropOwner() !== 'edit') { carveCount.classList.add('hidden'); return; }
    const n = viewer.trimInsideCount();
    const total = viewer.splatGaussianCount;
    carveCount.textContent = `Carve removes ~${n.toLocaleString()} gaussians inside the region${total ? ` (${Math.round(100 * n / total)}%)` : ''}.`;
    carveCount.classList.remove('hidden');
}
let carveCountTimer = 0;
function updateCarveCountDebounced(): void { clearTimeout(carveCountTimer); carveCountTimer = window.setTimeout(updateCarveCount, 150); }
for (const id of ['carve-box-on', 'carve-sphere-on']) $(id).addEventListener('change', syncCarveBtn);
syncCarveBtn();
carveRemoveBtn.onclick = () => {
    const input = editInput.value;
    if (!input) return showToast('Pick a splat to edit first', true);
    if (!/\.ply$/i.test(input)) return showToast('Carve works on .ply sources — convert to PLY first', true);
    const region = carveRegion();
    if (!region) return showToast('Enable a Box or Sphere region to carve out', true);
    if (jobBusy) return showToast('A job is running — wait for it to finish', true);
    if (!confirm(`Remove the gaussians inside the region from ${input}? This writes a new trimmed .ply — the source is left untouched.`)) return;
    void runJob(() => api.startTrim({ input, options: { mode: 'remove', ...region } }), carveRemoveBtn);
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

// the Convert-panel transform + filter fields, shared by the Convert run and the
// linked-group apply (so a group edit replays exactly what a single convert would)
const transformFilterOptions = () => ({
    translate: [Number(tfX.value), Number(tfY.value), Number(tfZ.value)] as [number, number, number],
    rotate: [Number(rfX.value), Number(rfY.value), Number(rfZ.value)] as [number, number, number],
    scale: Number(tfScaleEl.value),
    filterHarmonics: $<HTMLSelectElement>('convert-harmonics').value,
    filterBox: $<HTMLInputElement>('filter-box-on').checked
        ? [boxMinX.value, boxMinY.value, boxMinZ.value, boxMaxX.value, boxMaxY.value, boxMaxZ.value]
        : undefined,
    filterSphere: $<HTMLInputElement>('filter-sphere-on').checked
        ? [Number(sphX.value), Number(sphY.value), Number(sphZ.value), Number(sphR.value)] as [number, number, number, number]
        : undefined,
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
    let lodFiles: string[] | undefined;
    let lodEnvFlags: boolean[] | undefined;
    if (convertFormat.value === 'lod' && lodMode.value === 'combine') {
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
            ...transformFilterOptions(),
            lodLevels: Number($<HTMLInputElement>('lod-levels').value),
            lodKeepPercent: Number($<HTMLInputElement>('lod-keep').value),
            lodChunkCount: Number($<HTMLInputElement>('lod-chunk-count').value),
            lodChunkExtent: Number($<HTMLInputElement>('lod-chunk-extent').value),
            lodFiles,
            lodEnvFlags,
            params: currentGenParams(),
            image: convertFormat.value === 'webp' ? webpImageOptions() : undefined
        }
    }), convertRun, $<HTMLInputElement>('convert-autoload').checked);
};

// ---------- linked group: apply the Convert transforms/filters to every member ----------
// Edit on a proxy (the loaded splat / Convert input), then fan the same transform +
// filter ops out to every ticked member — the LODs of one location stay consistent.
const groupMembersEl = $<HTMLDivElement>('group-members');
const groupApplyBtn = $<HTMLButtonElement>('group-apply');
const groupWarn = $<HTMLDivElement>('group-warn');

const checkedMembers = (): string[] =>
    [...groupMembersEl.querySelectorAll<HTMLInputElement>('input:checked')].map((i) => i.value);

const updateGroupApply = (): void => {
    const n = checkedMembers().length;
    groupApplyBtn.textContent = n ? `Apply transforms to ${n} member${n > 1 ? 's' : ''}` : 'Apply transforms to members';
    groupApplyBtn.disabled = n === 0;
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
    if (['lod', 'webp', 'csv'].includes(format)) {
        return showToast('Pick a splat output format in the Convert panel (PLY / SOG / …) — streamed-LOD, WebP and CSV don’t carry these per-gaussian edits', true);
    }
    groupWarn.classList.add('hidden');
    groupApplyBtn.disabled = true; // claim the button now — the stats await below is a re-entrancy gap
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
        // fan out one edited copy per member, sequentially (jobBusy + runJob serialize)
        const options = {
            ...transformFilterOptions(),
            filterNaN: $<HTMLInputElement>('convert-filter-nan').checked,
            decimate: $<HTMLInputElement>('convert-decimate').value.trim(),
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

$<HTMLButtonElement>('apply-direct-scale').onclick = () => {
    const input = editInput.value;
    if (!input) return showToast('Pick a splat to edit', true);
    const factor = Number($<HTMLInputElement>('direct-scale').value);
    if (!(factor > 0)) return showToast('Enter a positive scale factor', true);
    if (factor === 1) return showToast('Scale factor 1 leaves the splat unchanged', true);
    void runJob(() => api.startConvert({ input, format: 'ply', options: { transform: { scale: factor } } }), $<HTMLButtonElement>('apply-direct-scale'));
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
const removeSplat = () => { viewer?.clearSplat(); hideChip(hudSplat); currentSplatName = null; syncPreview(); rebuildSceneList(); };
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
        this.hint.textContent = 'Set the Convert output to “WebP image (render)” to preview the render camera here.';
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
    for (const id of ['panel-convert', 'panel-analyze', 'panel-edit', 'panel-collision']) {
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
// Collision tab being visible) or the Scene tab is shown
dock.onDidActivePanelChange(() => rebuildSceneList());
(window as unknown as { __dock: DockviewApi }).__dock = dock; // debug handle

// ---------- top menu bar (Window / Layout) ----------
const LAYOUT_VERSION = 1;
let saveTimer: number | undefined;
const persistNow = (): void => { void api.saveLayout({ __v: LAYOUT_VERSION, dockview: dock.toJSON() as unknown as Record<string, unknown> }); };

type MenuItem = { label: string; checked?: boolean; onClick: () => void };
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
            row.innerHTML = `<span class="menu-check">${it.checked ? '✓' : ''}</span><span>${it.label}</span>`;
            row.onclick = () => { close(); it.onClick(); };
            drop.appendChild(row);
        }
        drop.classList.remove('hidden');
        document.addEventListener('pointerdown', onDoc, true);
    };
    return wrap;
}

function buildMenuBar(): void {
    const bar = $('menubar');
    bar.innerHTML = '';
    bar.append(
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
        showToast('No projects yet — click "+ New" to create one', true);
        return;
    }
    await switchProject(projects.includes(preferred ?? '') ? preferred! : projects[0]);
};

projectSelect.onchange = () => void switchProject(projectSelect.value);

$<HTMLButtonElement>('project-new').onclick = async () => {
    const name = window.prompt('New project name:')?.trim();
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
    .catch((err) => showToast(`Can't reach the local server — projects unavailable (${err})`, true));
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
        updateRenderFrustum(); // show the WebP frustum if WebP is the restored format
        rebuildSceneList();
        (window as unknown as { __viewer: SplatViewer }).__viewer = v; // debug handle
    })
    .catch((err) => {
        showToast(`Failed to start viewer: ${err}`, true);
        console.error(err);
    });
