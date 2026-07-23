// Files panel: the workspace file list (rows, eyes, selection/bulk actions,
// details cards, context menu) and viewFile — loading files into viewer layers.
// Registries + late-bound callbacks break upward calls into the panel modules.
import * as api from './api';
import { $, fileList, convertInput, genInput, lodInput, renderInput, collisionInput, analyzeInput, editInput, skyboxSelect, hudSplat, hudCollision, hudVoxel, convertFormat, analyzeRun } from './dom';
import { viewer, layerVisible, currentSplatName, currentCollisionName, currentVoxelName, setCurrentSplatName, setCurrentCollisionName, setCurrentVoxelName, splatFileNames, setSplatFileNames, lodMetaCache, hooks } from './state';
import { showToast, fmtSize, fmtCount, twoStageConfirm } from './ui';
import { formState } from './form-state';
import { winById, openWindow } from './dockview';
import { viewportCallbacks, setChip, hideChip, applyLayerVisible, rebuildSceneList, removeCollision, removeVoxels } from './viewport';

// run at the end of every refreshFiles — panels (export rows, LOD rows, linked
// group) register a callback at their module eval instead of being called upward
export const filesRefreshHooks: Array<() => void> = [];
// run after viewFile loads a splat — edit/region panels re-sync their previews
export const afterViewFileHooks: Array<() => void> = [];
// late-bound context-menu action: generate-panel supplies "run generator + view"
export const fileActionCallbacks: { generateView: () => void } = { generateView: () => {} };

// ---------- file list ----------
let lastFiles: api.FileEntry[] = [];
// rows with an open details card / a ticked checkbox — survive list re-renders
const expandedFiles = new Set<string>();
export const selectedFiles = new Set<string>(); // groups' bulk-add reads this
// live row elements for the expandable (splat/lod) rows, rebuilt per render
const fileRows = new Map<string, { li: HTMLLIElement; chev: HTMLButtonElement }>();

// repopulate a file <select>, keeping the current choice when still present
export const fillSelect = (select: HTMLSelectElement, names: string[]) => {
    const prev = select.value;
    select.innerHTML = '';
    // never silently snap to the first of SEVERAL files — a wrong input burns GPU
    // minutes; a single candidate is unambiguous, so save the click
    if (names.length !== 1 && (names.length === 0 || !names.includes(prev))) {
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
    else if (names.length === 1) select.value = names[0];
};

// Re-fetch and re-render the whole Files panel (rows, eyes, selection, details,
// input selects); `highlight` names flash as fresh job outputs.
export const refreshFiles = async (highlight?: Set<string>) => {
    const files = await api.listFiles();
    lastFiles = files;
    // drop expansion/selection state for names no longer listed
    const listed = new Set(files.map((f) => f.name));
    for (const n of [...expandedFiles]) if (!listed.has(n)) expandedFiles.delete(n);
    for (const n of [...selectedFiles]) if (!listed.has(n)) selectedFiles.delete(n);

    // anything the CLI can read (incl. .spz/.splat/.ksplat/.lcc/.lcc2), not just
    // what the engine can render
    const splatFiles = files.filter((f) => f.kind === 'splat');
    setSplatFileNames(splatFiles.map((f) => f.name));
    // .mjs generators are valid convert/analyze inputs, but not collision/LOD sources
    const generatorNames = files.filter((f) => f.kind === 'generator').map((f) => f.name);
    // lod-meta.json (our own streamed-SOG output) is a valid convert/analyze INPUT
    // (--select-lod reads back a subset of levels), but not a collision/LOD/
    // render/edit source — those keep taking only actual splat files
    const lodMetaNames = files.filter((f) => f.kind === 'lod').map((f) => f.name);
    const convertNames = [...splatFileNames, ...generatorNames, ...lodMetaNames];
    fillSelect(convertInput, convertNames);
    fillSelect(analyzeInput, convertNames);
    fillSelect(genInput, generatorNames);
    for (const select of [lodInput, renderInput, collisionInput, editInput]) {
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
        [genInput, 'gen-input', generatorNames],
        [lodInput, 'lod-input', splatFileNames],
        [renderInput, 'render-input', splatFileNames],
        [collisionInput, 'collision-input', splatFileNames],
        [editInput, 'edit-input', splatFileNames]
    ] as const) {
        const want = formState[id];
        if (!select.value && typeof want === 'string' && names.includes(want)) select.value = want;
    }
    fileList.innerHTML = '';
    fileRows.clear();
    let firstNew: HTMLLIElement | null = null;
    for (const f of files) {
        // derive voxel viewability client-side too, so a server started before
        // this feature still gets the eye toggle
        if (!f.viewable && f.name.endsWith('.voxel.json')) f.viewable = 'voxel';
        const li = document.createElement('li');
        if (highlight?.has(f.name)) {
            li.classList.add('new');
            firstNew ??= li;
        }

        // bulk-select checkbox
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'file-check';
        check.title = 'Select for bulk actions';
        check.checked = selectedFiles.has(f.name);
        check.onchange = () => {
            if (check.checked) selectedFiles.add(f.name);
            else selectedFiles.delete(f.name);
            updateBulkBar();
        };
        li.appendChild(check);

        // details chevron (splat/lod rows only)
        const expandable = f.kind === 'splat' || f.kind === 'lod';
        if (expandable) {
            const chev = document.createElement('button');
            chev.className = 'file-chevron';
            chev.title = 'Details (counts, dates, LOD build recipe)';
            chev.textContent = expandedFiles.has(f.name) ? '▾' : '▸';
            chev.onclick = () => toggleDetails(f);
            li.appendChild(chev);
            fileRows.set(f.name, { li, chev });
        } else {
            li.appendChild(document.createElement('span'));
        }

        if (f.viewable) {
            const EYE_HINTS: Record<string, string> = {
                splat: 'Show / hide this splat in the 3D viewer. First show loads it; the last shown splat is the active one (Edit / Analyze / Collision).',
                collision: 'Show / hide this collision mesh as a wireframe overlay (loading replaces any other overlay)',
                voxel: 'Show / hide this voxel octree as translucent boxes (loading replaces any other voxel layer)'
            };
            const eye = document.createElement('button');
            eye.className = 'file-eye unloaded';
            eye.textContent = '👁';
            eye.dataset.name = f.name;
            eye.dataset.view = f.viewable;
            eye.title = EYE_HINTS[f.viewable];
            eye.onclick = () => void toggleFileEye(eye, f.name, f.viewable!);
            li.appendChild(eye);
        } else {
            li.appendChild(document.createElement('span')); // keep the grid aligned
        }

        const KIND_HINTS: Record<string, string> = {
            splat: 'Gaussian splat — usable as convert/collision input',
            lod: 'Streamed multi-LOD SOG — view streams chunks by camera distance; not usable as a conversion input',
            voxel: 'Sparse voxel octree (collision job output) — view it as translucent boxes, or use for runtime collision in supersplat-viewer',
            collision: 'Collision triangle mesh — view it as a wireframe over the splat',
            glb: 'glTF binary (KHR_gaussian_splatting splat export)',
            export: 'Export artifact (CSV / HTML / image)',
            generator: 'Procedural splat generator (.mjs) — run it from the Generate tab with -p params (Beta, local only)',
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

        // always appended (empty when unknown) so the grid stays aligned
        const count = document.createElement('span');
        count.className = 'count';
        if (typeof f.gaussians === 'number') {
            count.textContent = fmtCount(f.gaussians);
            let tip = `${f.gaussians.toLocaleString()} gaussians`;
            if (f.kind === 'lod' && f.lodCounts?.length) {
                tip += `\n${f.lodCounts.map((c, i) => `LOD ${i}: ${c.toLocaleString()}`).join(' · ')}`;
            }
            count.title = tip;
        }
        li.appendChild(count);

        const size = document.createElement('span');
        size.className = 'size';
        size.textContent = fmtSize(f.size);
        li.appendChild(size);

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
        const confirmDelete = twoStageConfirm(del, { armLabel: 'delete?', resetLabel: '✕' });
        del.onclick = async () => {
            if (!confirmDelete.confirm()) return;
            try {
                unloadDeleted(f.name);
                await api.deleteFile(f.name);
                await refreshFiles();
            } catch (err) {
                showToast(`Delete failed (${f.name}): ${err}`, true);
            }
        };
        li.appendChild(del);

        if (expandable && expandedFiles.has(f.name)) li.appendChild(buildDetails(f));
        fileList.appendChild(li);
    }
    updateFileEyes();
    updateBulkBar();
    firstNew?.scrollIntoView({ block: 'nearest' });
    for (const h of filesRefreshHooks) h(); // panels refill their own file rows
};

// load a file into its viewer layer (splat/collision/voxel); false on failure
export const viewFile = async (name: string, as: api.ViewKind): Promise<boolean> => {
    const v = viewer;
    if (!v) { showToast('Viewer is still starting up', true); return false; }
    try {
        const url = api.fileUrl(name);
        const filename = name.split('/').pop()!;
        if (!(as === 'splat' && v.isFileLoaded(name))) showToast(`Loading ${name}…`); // re-show is instant

        if (as === 'splat') {
            if (!(await v.showFile(name, url, filename))) return false; // superseded by an unload
            setChip(hudSplat, `splat: ${name}`);
            layerVisible.splat = true;
            v.setSplatVisible(true);
            setCurrentSplatName(name);
            for (const h of afterViewFileHooks) h(); // edit/region panels re-sync previews
        } else if (as === 'collision') {
            if (!(await v.loadCollision(url, filename))) return false;
            setCurrentCollisionName(name);
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
            setCurrentVoxelName(name);
            setChip(hudVoxel, `voxels: ${name} (${count.toLocaleString()} boxes)`);
            layerVisible.voxels = true;
            v.setVoxelsVisible(true);
            if (truncated) {
                showToast(`Voxel display capped at ${count.toLocaleString()} boxes — regenerate with a coarser voxel size for full coverage`, true);
            }
        }
        rebuildSceneList();
        hooks.scheduleUndoCapture(); // loading a splat is an undo step
        return true;
    } catch (err) {
        showToast(`Failed to load ${name}: ${err}`, true);
        return false;
    }
};

// ---------- per-row eye toggles + Show all / Hide all ----------
type EyeState = 'visible' | 'hidden' | 'unloaded';
const fileEyeState = (name: string, as: api.ViewKind): EyeState => {
    const v = viewer;
    if (!v) return 'unloaded';
    if (as === 'splat') return v.isFileLoaded(name) ? (v.isFileVisible(name) ? 'visible' : 'hidden') : 'unloaded';
    if (as === 'collision') return name === currentCollisionName && v.hasCollision ? (layerVisible.collision ? 'visible' : 'hidden') : 'unloaded';
    return name === currentVoxelName && v.hasVoxels ? (layerVisible.voxels ? 'visible' : 'hidden') : 'unloaded';
};

/** Repaint every row eye (bright = visible, dim = loaded + hidden, faint = not loaded). */
const updateFileEyes = (): void => {
    for (const b of fileList.querySelectorAll<HTMLButtonElement>('button.file-eye')) {
        if (b.classList.contains('loading')) continue;
        const state = fileEyeState(b.dataset.name!, b.dataset.view as api.ViewKind);
        b.textContent = state === 'hidden' ? '🙈' : '👁';
        b.classList.toggle('off', state === 'hidden');
        b.classList.toggle('unloaded', state === 'unloaded');
    }
};

// eye button: show the file in the viewer, or hide/unload it if already shown
const toggleFileEye = async (eye: HTMLButtonElement, name: string, as: api.ViewKind): Promise<void> => {
    const v = viewer;
    if (!v) return showToast('Viewer is still starting up', true);
    if (fileEyeState(name, as) === 'visible') {
        if (as === 'splat') {
            v.hideFile(name);
            if (name === v.activeSplatName) layerVisible.splat = false;
        } else if (as === 'collision') {
            layerVisible.collision = false;
            applyLayerVisible('collision');
        } else {
            layerVisible.voxels = false;
            applyLayerVisible('voxels');
        }
        rebuildSceneList();
    } else {
        // not loaded → load + show; loaded + hidden → show (either way it becomes active)
        eye.classList.add('loading');
        eye.textContent = '◌';
        eye.disabled = true;
        try { await viewFile(name, as); }
        finally { eye.disabled = false; eye.classList.remove('loading'); }
    }
    updateFileEyes();
};

/** Reflect the viewer's active splat into the HUD chip + preview plumbing. */
const syncActiveSplatChip = (): void => {
    setCurrentSplatName(viewer?.activeSplatName ?? null);
    if (currentSplatName) setChip(hudSplat, `splat: ${currentSplatName}`);
    else hideChip(hudSplat);
};
viewportCallbacks.updateFileEyes = updateFileEyes;
viewportCallbacks.syncActiveSplatChip = syncActiveSplatChip;

/** A deleted file must release whatever the viewer holds for it first. */
const unloadDeleted = (name: string): void => {
    const v = viewer;
    if (v?.isFileLoaded(name)) {
        v.unloadFile(name);
        syncActiveSplatChip();
        viewportCallbacks.syncPreview();
        rebuildSceneList();
    }
    if (name === currentCollisionName) removeCollision();
    if (name === currentVoxelName) removeVoxels();
};

// two-stage >20M-gaussian confirm + sequential load, shared by Show all / Show selected
const wireShowButton = (btn: HTMLButtonElement, label: string, pickTargets: () => api.FileEntry[]): void => {
    const confirmLoad = twoStageConfirm(btn, { resetLabel: label });
    btn.onclick = async () => {
        const v = viewer;
        if (!v) return showToast('Viewer is still starting up', true);
        const targets = pickTargets();
        if (!targets.length) return showToast('No viewable splat files to show', true);
        // confirm when the files that would NEWLY load sum past 20M gaussians
        const fresh = targets.filter((f) => !v.isFileLoaded(f.name));
        const total = fresh.reduce((s, f) => s + (f.gaussians ?? 0), 0);
        if (total > 20_000_000) {
            if (!confirmLoad.confirm(`Load ~${fmtCount(total)} gaussians?`)) return;
        } else {
            confirmLoad.disarm();
        }
        btn.disabled = true;
        try {
            for (const f of targets) await viewFile(f.name, 'splat');
        } finally {
            btn.disabled = false;
            updateFileEyes();
        }
    };
};
wireShowButton($<HTMLButtonElement>('files-show-all'), 'Show all', () => lastFiles.filter((f) => f.viewable === 'splat'));

$<HTMLButtonElement>('files-hide-all').onclick = () => {
    const v = viewer;
    if (!v) return;
    for (const lf of v.loadedFiles()) if (lf.visible) v.hideFile(lf.name);
    if (v.hasSplat) layerVisible.splat = false;
    if (v.hasCollision && layerVisible.collision) { layerVisible.collision = false; applyLayerVisible('collision'); }
    if (v.hasVoxels && layerVisible.voxels) { layerVisible.voxels = false; applyLayerVisible('voxels'); }
    rebuildSceneList();
};

// ---------- row selection + bulk actions ----------
const selectAllBox = $<HTMLInputElement>('files-select-all');
const bulkBar = $<HTMLDivElement>('file-bulk-bar');
const bulkCount = $<HTMLSpanElement>('bulk-count');
const bulkDeleteBtn = $<HTMLButtonElement>('bulk-delete');

const bulkConfirm = twoStageConfirm(bulkDeleteBtn, { resetLabel: 'Delete selected' });

/** Sync the select-all tri-state + bulk bar to the current selection. */
const updateBulkBar = (): void => {
    const n = selectedFiles.size;
    selectAllBox.checked = n > 0 && n === lastFiles.length;
    selectAllBox.indeterminate = n > 0 && n < lastFiles.length;
    bulkBar.classList.toggle('hidden', n === 0);
    bulkCount.textContent = n ? `${n} selected` : '';
    bulkConfirm.disarm();
};

selectAllBox.onchange = () => {
    selectedFiles.clear();
    if (selectAllBox.checked) for (const f of lastFiles) selectedFiles.add(f.name);
    for (const box of fileList.querySelectorAll<HTMLInputElement>('input.file-check')) box.checked = selectAllBox.checked;
    updateBulkBar();
};

wireShowButton($<HTMLButtonElement>('bulk-show'), 'Show selected',
    () => lastFiles.filter((f) => f.viewable === 'splat' && selectedFiles.has(f.name)));

$<HTMLButtonElement>('bulk-hide').onclick = () => {
    const v = viewer;
    if (!v) return;
    for (const lf of v.loadedFiles()) if (lf.visible && selectedFiles.has(lf.name)) v.hideFile(lf.name);
    if (v.activeSplatName && selectedFiles.has(v.activeSplatName)) layerVisible.splat = false;
    if (currentCollisionName && selectedFiles.has(currentCollisionName) && layerVisible.collision) { layerVisible.collision = false; applyLayerVisible('collision'); }
    if (currentVoxelName && selectedFiles.has(currentVoxelName) && layerVisible.voxels) { layerVisible.voxels = false; applyLayerVisible('voxels'); }
    rebuildSceneList();
};

// two-stage delete, then unload + delete each selected file sequentially
bulkDeleteBtn.onclick = async () => {
    const names = lastFiles.filter((f) => selectedFiles.has(f.name)).map((f) => f.name);
    if (!names.length) return;
    if (!bulkConfirm.confirm(`Delete ${names.length} file${names.length > 1 ? 's' : ''}?`)) return;
    bulkDeleteBtn.disabled = true;
    try {
        for (const name of names) {
            unloadDeleted(name);
            try {
                await api.deleteFile(name);
                selectedFiles.delete(name);
            } catch (err) {
                showToast(`Delete failed (${name}): ${err}`, true);
            }
        }
    } finally {
        bulkDeleteBtn.disabled = false;
        await refreshFiles().catch(() => showToast('Couldn\'t refresh the file list', true));
    }
};

// ---------- row details card ----------
const detailRow = (label: string, value: string): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = 'detail-row';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('span');
    v.textContent = value;
    row.append(l, v);
    return row;
};

/** The bundle's sibling build-meta.json; null = none on disk. Cached per name+mtime. */
const fetchLodMeta = async (f: api.FileEntry): Promise<api.LodBuildMeta | null> => {
    const key = `${f.name}@${f.mtime}`;
    const hit = lodMetaCache.get(key);
    if (hit !== undefined) return hit;
    // raw fetch on purpose: this reads a workspace file over /files, not an API route
    const res = await fetch(api.fileUrl(f.name.replace(/lod-meta\.json$/, 'build-meta.json')));
    if (res.status === 404) { lodMetaCache.set(key, null); return null; }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const meta = (await res.json()) as api.LodBuildMeta;
    lodMetaCache.set(key, meta);
    return meta;
};

// per-level table + settings + bake line from a bundle's build recipe
const renderRecipe = (host: HTMLElement, recipe: api.LodBuildMeta): void => {
    const table = document.createElement('table');
    table.className = 'lod-recipe';
    const head = table.createTHead().insertRow();
    for (const h of ['Level', 'Source', 'Keep %', 'Gaussians']) {
        const th = document.createElement('th');
        th.textContent = h;
        head.appendChild(th);
    }
    const body = table.createTBody();
    for (const l of recipe.levels ?? []) {
        const tr = body.insertRow();
        if (l.environment) tr.className = 'env';
        tr.insertCell().textContent = l.environment ? 'env' : `LOD ${l.level}`;
        tr.insertCell().textContent = l.source;
        tr.insertCell().textContent = typeof l.keepPercent === 'number' ? `${l.keepPercent}%` : '';
        tr.insertCell().textContent = typeof l.gaussians === 'number' ? l.gaussians.toLocaleString() : '';
    }
    host.appendChild(table);
    const s = recipe.settings ?? {};
    const parts = [
        `mode ${recipe.mode}`,
        s.iterations != null ? `iterations ${s.iterations}` : '',
        s.maxWorkers != null ? `workers ${s.maxWorkers}` : '',
        s.device != null ? `device ${s.device}` : '',
        s.chunkCount != null ? `chunks ${s.chunkCount}K / ${s.chunkExtent} m` : ''
    ].filter(Boolean);
    if (parts.length) host.appendChild(detailRow('Settings', parts.join(' · ')));
    const versions = [
        recipe.generator?.app ? `Splat Studio ${recipe.generator.app}` : '',
        recipe.generator?.splatTransform ? `splat-transform ${recipe.generator.splatTransform}` : ''
    ].filter(Boolean).join(' · ');
    const baked = recipe.createdAt ? new Date(recipe.createdAt).toLocaleString() : '';
    if (baked || versions) host.appendChild(detailRow('Baked', [baked, versions].filter(Boolean).join(' — ')));
};

// expanded per-file detail card (size, counts, LOD recipe when present)
const buildDetails = (f: api.FileEntry): HTMLDivElement => {
    const card = document.createElement('div');
    card.className = 'file-details';
    if (typeof f.gaussians === 'number') card.appendChild(detailRow('Gaussians', f.gaussians.toLocaleString()));
    card.appendChild(detailRow('Size', `${fmtSize(f.size)} (${f.size.toLocaleString()} bytes)`));
    card.appendChild(detailRow('Modified', new Date(f.mtime).toLocaleString()));
    card.appendChild(detailRow('Kind', f.kind));
    card.appendChild(detailRow('Path', f.name));
    if (f.kind !== 'lod') return card;
    const recipeHost = document.createElement('div');
    const note = document.createElement('div');
    note.className = 'detail-note';
    note.textContent = 'Loading build recipe…';
    recipeHost.appendChild(note);
    card.appendChild(recipeHost);
    void fetchLodMeta(f).then((recipe) => {
        note.remove();
        if (recipe) return renderRecipe(recipeHost, recipe);
        const miss = document.createElement('div');
        miss.className = 'detail-note';
        miss.textContent = 'No build recipe (built before this feature)';
        recipeHost.appendChild(miss);
        if (f.lodCounts?.length) {
            recipeHost.appendChild(detailRow('Levels', f.lodCounts.map((c, i) => `LOD ${i}: ${c.toLocaleString()}`).join(' · ')));
        }
    }).catch((err) => { note.textContent = `Couldn't read build recipe: ${err}`; });
    return card;
};

// expand/collapse a file row's detail card
const toggleDetails = (f: api.FileEntry): void => {
    const row = fileRows.get(f.name);
    if (!row) return;
    const open = row.li.querySelector('.file-details');
    if (open) {
        open.remove();
        expandedFiles.delete(f.name);
        row.chev.textContent = '▸';
    } else {
        row.li.appendChild(buildDetails(f));
        expandedFiles.add(f.name);
        row.chev.textContent = '▾';
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
    unloadDeleted(f.name);
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
    if (isSplat || isLod) items.push({ label: 'Details', hint: 'Expand the row\'s inline details card (counts, dates, LOD build recipe)', run: () => toggleDetails(f) });

    if (isGenerator) {
        items.push({ label: '✨  Generate & view', hint: 'Run the .mjs generator and load the result', run: () => { prefillSelect(genInput, f.name); openPanel('panel-generate'); fileActionCallbacks.generateView(); } });
    }
    if (isRaw) {
        items.push({ label: 'Export → SOG bundle', hint: 'Compress to a single .sog (~95% smaller)', run: () => { prefillSelect(convertInput, f.name); prefillSelect(convertFormat, 'sog'); openPanel('panel-convert'); } });
        items.push({ label: 'Export → Streamed LOD', hint: 'Streamable multi-LOD SOG for big scenes', run: () => { prefillSelect(lodInput, f.name); openPanel('panel-lod'); } });
        items.push({ label: 'Render → WebP image', hint: 'Render a lossless image via the GPU rasterizer', run: () => { prefillSelect(renderInput, f.name); openPanel('panel-render'); } });
    }
    if (isSplat || isGenerator) {
        items.push({ label: isRaw ? 'Export (other formats)…' : 'Export as…', hint: 'Open the Export panel with this file selected', run: () => { prefillSelect(convertInput, f.name); openPanel('panel-convert'); } });
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
