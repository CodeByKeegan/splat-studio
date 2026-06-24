import * as api from './api';
import { SplatViewer } from './viewer';

const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
};

const fileList = $<HTMLUListElement>('file-list');
const convertInput = $<HTMLSelectElement>('convert-input');
const collisionInput = $<HTMLSelectElement>('collision-input');
const toastStack = $<HTMLDivElement>('toast-stack');
const hudSplat = $<HTMLSpanElement>('hud-splat');
const hudCollision = $<HTMLSpanElement>('hud-collision');
const hudVoxel = $<HTMLSpanElement>('hud-voxel');
const jobTitle = $<HTMLSpanElement>('job-title');
const jobStatus = $<HTMLSpanElement>('job-status');
const jobCommand = $<HTMLElement>('job-command');
const jobLog = $<HTMLPreElement>('job-log');
const sidebar = $<HTMLElement>('sidebar');

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
const FILE_SELECT_IDS = new Set(['convert-input', 'collision-input']);
const formState: Record<string, string | boolean> = (() => {
    try { return JSON.parse(localStorage.getItem(FORM_KEY) ?? '{}'); } catch { return {}; }
})();

sidebar.addEventListener('change', (e) => {
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

    // anything the CLI can read (incl. .spz/.splat/.ksplat/.lcc), not just
    // what the engine can render; lod-meta.json is viewable but not a CLI input
    const splatFiles = files.filter((f) => f.kind === 'splat' && !f.name.endsWith('lod-meta.json'));
    splatFileNames = splatFiles.map((f) => f.name);
    for (const select of [convertInput, collisionInput, ...lodRowSelects()]) {
        fillSelect(select, splatFileNames);
    }
    // re-apply the persisted choice once its file exists again
    for (const [select, id] of [[convertInput, 'convert-input'], [collisionInput, 'collision-input']] as const) {
        const want = formState[id];
        if (!select.value && typeof want === 'string' && splatFileNames.includes(want)) select.value = want;
    }

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
            $<HTMLInputElement>('show-splat').checked = true;
            v.setSplatVisible(true);
        } else if (as === 'collision') {
            if (!(await v.loadCollision(url, filename))) return;
            setChip(hudCollision, `collision: ${name} (${v.collisionTriangles.toLocaleString()} tris)`);
            $<HTMLInputElement>('show-collision').checked = true;
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
            $<HTMLInputElement>('show-voxels').checked = true;
            v.setVoxelsVisible(true);
            if (truncated) {
                showToast(`Voxel display capped at ${count.toLocaleString()} boxes — regenerate with a coarser voxel size for full coverage`, true);
            }
        }
    } catch (err) {
        showToast(`Failed to load ${name}: ${err}`, true);
    }
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
        }
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

// ---------- jobs ----------
const jobCancel = $<HTMLButtonElement>('job-cancel');
const convertRun = $<HTMLButtonElement>('convert-run');
const collisionRun = $<HTMLButtonElement>('collision-run');
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
const runJob = async (start: () => Promise<string>, button: HTMLButtonElement) => {
    const prevLabel = button.textContent;
    convertRun.disabled = true;
    collisionRun.disabled = true;
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
            // auto-load results into the viewer, then toast so 'done' stays visible
            for (const v of job.viewables) {
                await viewFile(v.name, v.as);
            }
            showToast(`${job.title} — done: ${job.outputs.join(', ')}`);
        } else if (/DEVICE_HUNG|device lost/i.test(job.log)) {
            showToast(`${job.title} — the GPU watchdog reset the device (TDR). On large scenes this is usually the cluster-filter pass: retry with "Filter to connected cluster" unchecked.`, true);
        } else {
            const lastLine = job.log.split('\n').map((l) => l.trim()).filter(Boolean).pop();
            showToast(`${job.title} — failed: ${lastLine?.slice(0, 160) ?? 'see the Job panel log'}`, true);
        }
    } catch (err) {
        showToast(`Couldn't start job: ${err}`, true);
    } finally {
        convertRun.disabled = false;
        collisionRun.disabled = false;
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
    [...lodFileRows.children].forEach((row, i) => {
        const label = row.querySelector('.lod-label');
        if (label) label.textContent = `LOD ${i + 1}`;
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
    const remove = document.createElement('button');
    remove.textContent = '✕';
    remove.title = 'Remove this level';
    remove.onclick = () => {
        row.remove();
        relabelLodRows();
        updateConvertRows(); // combine mode always keeps at least one row
    };
    row.append(label, select, remove);
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
    'html': 'Convert → HTML viewer'
};

const updateConvertRows = () => {
    const f = convertFormat.value;
    const isLod = f === 'lod';
    const combine = lodMode.value === 'combine';
    $('row-iterations').classList.toggle('hidden', !(f === 'sog' || f === 'sog-unbundled' || f === 'html' || isLod));
    $('row-spz-version').classList.toggle('hidden', f !== 'spz');
    $('row-decimate').classList.toggle('hidden', isLod); // lod has its own level controls
    $('convert-actions').classList.toggle('hidden', isLod); // transforms/filters don't apply to LOD bakes
    $('row-lod-mode').classList.toggle('hidden', !isLod);
    $('row-lod-levels').classList.toggle('hidden', !isLod || combine);
    $('row-lod-files').classList.toggle('hidden', !isLod || !combine);
    $('row-lod-chunks').classList.toggle('hidden', !isLod);
    if (isLod && combine && lodFileRows.children.length === 0) addLodRow();
    if (!convertRun.disabled) convertRun.textContent = RUN_LABELS[f] ?? 'Convert';
};
convertFormat.onchange = updateConvertRows;
lodMode.onchange = updateConvertRows;
restoreFormState();
updateConvertRows();

// reveal each optional filter's inputs only when its checkbox is on
const ACTION_TOGGLES: [string, string][] = [
    ['filter-box-on', 'filter-box-rows'],
    ['filter-sphere-on', 'filter-sphere-rows'],
    ['filter-value-on', 'filter-value-rows'],
    ['filter-floaters-on', 'filter-floaters-rows']
];
const syncActionRows = () => {
    for (const [cb, rows] of ACTION_TOGGLES) $(rows).classList.toggle('hidden', !$<HTMLInputElement>(cb).checked);
};
for (const [cb] of ACTION_TOGGLES) $(cb).addEventListener('change', syncActionRows);
syncActionRows();

convertRun.onclick = () => {
    const input = convertInput.value;
    if (!input) return showToast('Pick an input file first', true);
    if (!panelValid('panel-convert')) return;
    let lodFiles: string[] | undefined;
    if (convertFormat.value === 'lod' && lodMode.value === 'combine') {
        lodFiles = lodRowSelects().map((s) => s.value).filter(Boolean);
        if (lodFiles.length === 0) {
            return showToast('Add at least one LOD level file, or switch LOD source to decimate', true);
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
            spzVersion: Number($<HTMLSelectElement>('convert-spz-version').value),
            decimate: $<HTMLInputElement>('convert-decimate').value.trim(),
            filterNaN: $<HTMLInputElement>('convert-filter-nan').checked,
            device: $<HTMLInputElement>('convert-cpu').checked ? 'cpu' : 'auto',
            translate: [
                Number($<HTMLInputElement>('tf-translate-x').value),
                Number($<HTMLInputElement>('tf-translate-y').value),
                Number($<HTMLInputElement>('tf-translate-z').value)
            ],
            rotate: [
                Number($<HTMLInputElement>('tf-rotate-x').value),
                Number($<HTMLInputElement>('tf-rotate-y').value),
                Number($<HTMLInputElement>('tf-rotate-z').value)
            ],
            scale: Number($<HTMLInputElement>('tf-scale').value),
            filterHarmonics: $<HTMLSelectElement>('convert-harmonics').value,
            filterBox: $<HTMLInputElement>('filter-box-on').checked ? [
                $<HTMLInputElement>('box-min-x').value, $<HTMLInputElement>('box-min-y').value, $<HTMLInputElement>('box-min-z').value,
                $<HTMLInputElement>('box-max-x').value, $<HTMLInputElement>('box-max-y').value, $<HTMLInputElement>('box-max-z').value
            ] : undefined,
            filterSphere: $<HTMLInputElement>('filter-sphere-on').checked ? [
                Number($<HTMLInputElement>('sphere-x').value),
                Number($<HTMLInputElement>('sphere-y').value),
                Number($<HTMLInputElement>('sphere-z').value),
                Number($<HTMLInputElement>('sphere-r').value)
            ] : undefined,
            filterValue: $<HTMLInputElement>('filter-value-on').checked ? {
                column: $<HTMLSelectElement>('fv-column').value,
                comparator: $<HTMLSelectElement>('fv-cmp').value,
                value: Number($<HTMLInputElement>('fv-value').value)
            } : undefined,
            filterFloaters: $<HTMLInputElement>('filter-floaters-on').checked ? {
                size: $<HTMLInputElement>('ff-size').value,
                opacity: $<HTMLInputElement>('ff-op').value,
                min: $<HTMLInputElement>('ff-min').value
            } : undefined,
            mortonOrder: $<HTMLInputElement>('convert-morton').checked,
            lodLevels: Number($<HTMLInputElement>('lod-levels').value),
            lodKeepPercent: Number($<HTMLInputElement>('lod-keep').value),
            lodChunkCount: Number($<HTMLInputElement>('lod-chunk-count').value),
            lodChunkExtent: Number($<HTMLInputElement>('lod-chunk-extent').value),
            lodFiles
        }
    }), convertRun);
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
            meshShape: $<HTMLSelectElement>('mesh-shape').value as 'smooth' | 'faces'
        }
    }), collisionRun);
};

// ---------- viewer panel ----------
// guards: handlers are live before the async viewer boot finishes
$<HTMLInputElement>('show-splat').onchange = (e) =>
    viewer?.setSplatVisible((e.currentTarget as HTMLInputElement).checked);
$<HTMLInputElement>('show-collision').onchange = (e) =>
    viewer?.setCollisionVisible((e.currentTarget as HTMLInputElement).checked);
$<HTMLInputElement>('show-voxels').onchange = (e) =>
    viewer?.setVoxelsVisible((e.currentTarget as HTMLInputElement).checked);
$<HTMLInputElement>('show-seed-marker').onchange = (e) =>
    viewer?.setSeedMarkerVisible((e.currentTarget as HTMLInputElement).checked);
$<HTMLInputElement>('show-capsule').onchange = (e) =>
    viewer?.setCapsuleVisible((e.currentTarget as HTMLInputElement).checked);
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

// remove (unload) layers — distinct from the show/hide checkboxes above
const removeSplat = () => { viewer?.clearSplat(); hideChip(hudSplat); };
const removeCollision = () => { viewer?.clearCollision(); hideChip(hudCollision); };
const removeVoxels = () => { viewer?.clearVoxels(); hideChip(hudVoxel); };
hudSplat.querySelector('.chip-remove')?.addEventListener('click', removeSplat);
hudCollision.querySelector('.chip-remove')?.addEventListener('click', removeCollision);
hudVoxel.querySelector('.chip-remove')?.addEventListener('click', removeVoxels);
$<HTMLButtonElement>('clear-viewport').onclick = () => {
    viewer?.clearAll();
    hideChip(hudSplat);
    hideChip(hudCollision);
    hideChip(hudVoxel);
};

// ---------- collapsible panels ----------
const PANELS_KEY = 'splat-studio.panels';
const panelState: Record<string, boolean> = (() => {
    try { return JSON.parse(localStorage.getItem(PANELS_KEY) ?? '{}'); } catch { return {}; }
})();
for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
    if (panel.id === 'panel-job') continue; // the live panel never collapses
    panel.classList.toggle('collapsed', panelState[panel.id] ?? panel.id === 'panel-viewer');
    panel.querySelector('h2')?.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        const collapsed = panel.classList.toggle('collapsed');
        panelState[panel.id] = collapsed;
        localStorage.setItem(PANELS_KEY, JSON.stringify(panelState));
    });
}

// ---------- sidebar resizer ----------
const appEl = $<HTMLDivElement>('app');
const resizer = $<HTMLDivElement>('resizer');
const SIDEBAR_KEY = 'splat-studio.sidebar-width';

const applySidebarWidth = (width: number) => {
    const clamped = Math.round(Math.min(Math.max(width, 280), Math.max(320, window.innerWidth * 0.7)));
    appEl.style.setProperty('--sidebar-w', `${clamped}px`);
    return clamped;
};

const currentSidebarWidth = () =>
    parseInt(getComputedStyle(appEl).getPropertyValue('--sidebar-w')) || 360;

const savedWidth = Number(localStorage.getItem(SIDEBAR_KEY));
if (Number.isFinite(savedWidth) && savedWidth > 0) applySidebarWidth(savedWidth);

resizer.onpointerdown = (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add('dragging');
    document.body.style.userSelect = 'none';
    let width = 0;
    const onMove = (ev: PointerEvent) => { width = applySidebarWidth(ev.clientX - 2); };
    const onUp = () => {
        resizer.removeEventListener('pointermove', onMove);
        resizer.removeEventListener('pointerup', onUp);
        resizer.removeEventListener('pointercancel', onUp);
        resizer.classList.remove('dragging');
        document.body.style.userSelect = '';
        if (width) localStorage.setItem(SIDEBAR_KEY, String(width));
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onUp);
    resizer.addEventListener('pointercancel', onUp);
};
resizer.onkeydown = (e) => {
    const step = e.shiftKey ? 64 : 16;
    let width: number | null = null;
    if (e.key === 'ArrowLeft') width = currentSidebarWidth() - step;
    else if (e.key === 'ArrowRight') width = currentSidebarWidth() + step;
    else if (e.key === 'Home') width = 280;
    if (width !== null) {
        e.preventDefault();
        localStorage.setItem(SIDEBAR_KEY, String(applySidebarWidth(width)));
    }
};

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
    await refreshFiles();
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
        v.setSeedMarkerVisible($<HTMLInputElement>('show-seed-marker').checked);
        v.setCapsuleVisible($<HTMLInputElement>('show-capsule').checked);
        (window as unknown as { __viewer: SplatViewer }).__viewer = v; // debug handle
    })
    .catch((err) => {
        showToast(`Failed to start viewer: ${err}`, true);
        console.error(err);
    });
