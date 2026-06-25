import * as api from './api';
import { SplatViewer } from './viewer';
import type { SelId } from './viewer';
import { createDockview, markDockviewPackageLoaded } from 'dockview-core';
import type { DockviewApi, IContentRenderer } from 'dockview-core';
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

    // anything the CLI can read (incl. .spz/.splat/.ksplat/.lcc), not just
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
            currentSplatName = name;
            syncPreview(); // apply the live Convert preview if this is the input
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
        rebuildSceneList();
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
const runJob = async (start: () => Promise<string>, button: HTMLButtonElement): Promise<api.Job | undefined> => {
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
            // auto-load results into the viewer, then toast so 'done' stays visible
            for (const v of job.viewables) {
                await viewFile(v.name, v.as);
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
    'html': 'Convert → HTML viewer',
    'webp': 'Render → WebP'
};

const updateConvertRows = () => {
    const f = convertFormat.value;
    const isLod = f === 'lod';
    const isWebp = f === 'webp';
    const combine = lodMode.value === 'combine';
    $('row-iterations').classList.toggle('hidden', !(f === 'sog' || f === 'sog-unbundled' || f === 'html' || isLod));
    $('row-spz-version').classList.toggle('hidden', f !== 'spz');
    $('row-decimate').classList.toggle('hidden', isLod || isWebp); // no decimate for LOD/render
    $('convert-actions').classList.toggle('hidden', isLod); // transforms/filters don't apply to LOD bakes
    $('row-lod-mode').classList.toggle('hidden', !isLod);
    $('row-lod-levels').classList.toggle('hidden', !isLod || combine);
    $('row-lod-files').classList.toggle('hidden', !isLod || !combine);
    $('row-lod-chunks').classList.toggle('hidden', !isLod);
    $('html-rows').classList.toggle('hidden', f !== 'html');
    $('webp-rows').classList.toggle('hidden', !isWebp);
    if (isLod && combine && lodFileRows.children.length === 0) addLodRow();
    if (!convertRun.disabled) convertRun.textContent = RUN_LABELS[f] ?? 'Convert';
};
convertFormat.onchange = updateConvertRows;
lodMode.onchange = updateConvertRows;

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
    $('row-lod-select').classList.toggle('hidden', !input.toLowerCase().endsWith('.lcc'));
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
    ['filter-floaters-on', 'filter-floaters-rows']
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

const syncCropViz = () => {
    if (!viewer) return;
    const on = previewingInput();
    viewer.setCropBox(
        [numOrNull(boxMinX), numOrNull(boxMinY), numOrNull(boxMinZ)],
        [numOrNull(boxMaxX), numOrNull(boxMaxY), numOrNull(boxMaxZ)],
        on && $<HTMLInputElement>('filter-box-on').checked
    );
    viewer.setCropSphere(
        [Number(sphX.value), Number(sphY.value), Number(sphZ.value)],
        Number(sphR.value),
        on && $<HTMLInputElement>('filter-sphere-on').checked
    );
};

const syncPreview = () => { syncSplatXform(); syncCropViz(); };

for (const el of [tfX, tfY, tfZ, rfX, rfY, rfZ, tfScaleEl]) el.addEventListener('input', syncSplatXform);
for (const el of [boxMinX, boxMinY, boxMinZ, boxMaxX, boxMaxY, boxMaxZ, sphX, sphY, sphZ, sphR]) el.addEventListener('input', syncCropViz);
for (const id of ['filter-box-on', 'filter-sphere-on']) $(id).addEventListener('change', syncCropViz);
convertInput.addEventListener('change', syncPreview);
convertFormat.addEventListener('change', syncPreview);

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
            device: $<HTMLSelectElement>('convert-device').value,
            verbose: $<HTMLInputElement>('convert-verbose').checked,
            unbundled: $<HTMLInputElement>('convert-unbundled').checked,
            viewerSettings: $<HTMLInputElement>('convert-viewer-settings').value.trim(),
            lodSelect: $<HTMLInputElement>('convert-lod-select').value.trim(),
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
            lodFiles,
            params: currentGenParams(),
            image: convertFormat.value === 'webp' ? webpImageOptions() : undefined
        }
    }), convertRun);
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

const SCENE_ITEMS: { id: SelId; label: string; icon: string; gizmo: boolean; has: () => boolean }[] = [
    { id: 'splat', label: 'Splat', icon: '✨', gizmo: false, has: () => !!viewer?.hasSplat },
    { id: 'collision', label: 'Collision mesh', icon: '🧱', gizmo: false, has: () => !!viewer?.hasCollision },
    { id: 'voxels', label: 'Voxels', icon: '🧊', gizmo: false, has: () => !!viewer?.hasVoxels },
    { id: 'capsule', label: 'Carve capsule', icon: '💊', gizmo: true, has: () => !!viewer?.hasSplat },
    { id: 'render-camera', label: 'Render camera', icon: '🎥', gizmo: true, has: () => !!viewer?.hasRenderCamera }
];

function rebuildSceneList(): void {
    if (!viewer) return;
    const sel = viewer.selection;
    const items = SCENE_ITEMS.filter((it) => it.has());
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
        const gizmo = it.gizmo ? '<span class="scene-gizmo" title="movable">✥</span>' : '';
        li.innerHTML = `<span class="scene-icon">${it.icon}</span><span class="scene-name">${it.label}</span>${gizmo}`;
        li.onclick = () => { selectScene(it.id === viewer!.selection ? 'none' : it.id); };
        sceneList.appendChild(li);
    }
    $('cam-gizmo-mode').classList.toggle('hidden', sel !== 'render-camera');
}

function selectScene(id: SelId): void {
    viewer?.selectObject(id);
    rebuildSceneList();
}

// ---------- dockable layout (dockview) ----------
// Each panel + the viewport is an existing DOM node adopted by a dock component;
// dockview reparents the node (never recreates it), so the PlayCanvas canvas
// survives every dock/redock and tab switch. Built BEFORE the viewer boots so the
// canvas is already mounted in the visible dock.
export const DOCK_PANELS: { id: string; title: string; closable: boolean }[] = [
    { id: 'panel-files', title: 'Files', closable: true },
    { id: 'panel-convert', title: 'Convert', closable: true },
    { id: 'panel-analyze', title: 'Analyze', closable: true },
    { id: 'panel-edit', title: 'Edit', closable: true },
    { id: 'panel-collision', title: 'Collision', closable: true },
    { id: 'panel-scene', title: 'Scene', closable: true },
    { id: 'panel-viewer', title: 'Viewer', closable: true },
    { id: 'panel-job', title: 'Job', closable: false }
];

class AdoptPanel implements IContentRenderer {
    readonly element: HTMLElement;
    constructor(node: HTMLElement) { this.element = node; }
    init(): void {}
}

const dock: DockviewApi = createDockview($('dock'), {
    // 'always' keeps every panel's adopted DOM node mounted (hidden, not detached)
    // when its tab is inactive — so getElementById + bound handlers stay live and
    // the PlayCanvas canvas is never torn down.
    defaultRenderer: 'always',
    // o.name is the component string from addPanel: 'viewer' → #viewport, else a panel id
    createComponent: (o) => new AdoptPanel(o.name === 'viewer' ? $('viewport') : $(o.name))
});

const titleOf = (id: string): string => DOCK_PANELS.find((p) => p.id === id)?.title ?? id;

function applyDefaultLayout(): void {
    dock.clear();
    dock.addPanel({ id: 'viewer', component: 'viewer', title: 'Viewer 3D' });
    dock.addPanel({ id: 'panel-files', component: 'panel-files', title: 'Files', position: { referencePanel: 'viewer', direction: 'left' } });
    for (const id of ['panel-convert', 'panel-analyze', 'panel-edit', 'panel-collision']) {
        dock.addPanel({ id, component: id, title: titleOf(id), position: { referencePanel: 'panel-files', direction: 'within' } });
    }
    dock.addPanel({ id: 'panel-scene', component: 'panel-scene', title: 'Scene', position: { referencePanel: 'viewer', direction: 'right' } });
    dock.addPanel({ id: 'panel-viewer', component: 'panel-viewer', title: 'Viewer', position: { referencePanel: 'panel-scene', direction: 'within' } });
    dock.addPanel({ id: 'panel-job', component: 'panel-job', title: 'Job', position: { referencePanel: 'viewer', direction: 'below' } });
    // size the side/bottom groups so the 3D viewport keeps the bulk of the window
    dock.getPanel('panel-files')?.group.api.setSize({ width: 340 });
    dock.getPanel('panel-scene')?.group.api.setSize({ width: 300 });
    dock.getPanel('panel-job')?.group.api.setSize({ height: 180 });
    dock.getPanel('panel-files')?.api.setActive();
}
applyDefaultLayout();
// keep the scene list fresh when the Scene tab is shown
dock.getPanel('panel-scene')?.api.onDidVisibilityChange((e) => { if (e.isVisible) rebuildSceneList(); });
(window as unknown as { __dock: DockviewApi }).__dock = dock; // debug handle

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
        // crop gizmo -> reflect into the box/sphere fields (live), persist on release
        v.onCropSphereMove = (c) => { sphX.value = String(c.x); sphY.value = String(c.y); sphZ.value = String(c.z); };
        v.onCropBoxMove = (d) => {
            const shift = (el: HTMLInputElement, dv: number) => { if (el.value.trim() !== '') el.value = String(Math.round((Number(el.value) + dv) * 100) / 100); };
            shift(boxMinX, d.x); shift(boxMaxX, d.x);
            shift(boxMinY, d.y); shift(boxMaxY, d.y);
            shift(boxMinZ, d.z); shift(boxMaxZ, d.z);
        };
        v.onCropMoveEnd = () => {
            for (const el of [boxMinX, boxMinY, boxMinZ, boxMaxX, boxMaxY, boxMaxZ, sphX, sphY, sphZ, sphR]) el.dispatchEvent(new Event('change', { bubbles: true }));
            syncCropViz();
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
        syncPreview(); // reflect restored Convert fields once the viewer is up
        updateRenderFrustum(); // show the WebP frustum if WebP is the restored format
        rebuildSceneList();
        (window as unknown as { __viewer: SplatViewer }).__viewer = v; // debug handle
    })
    .catch((err) => {
        showToast(`Failed to start viewer: ${err}`, true);
        console.error(err);
    });
