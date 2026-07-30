// Upload: file-picker + window-level drag-and-drop into the workspace, and the
// ready-to-run sample .mjs generator. Leaf module — nothing imports it.
import * as api from './api';
import { $, fileList, convertInput, genInput, lodInput, renderInput, collisionInput, analyzeInput } from './dom';
import { splatFileNames } from './state';
import { showToast, fmtSize } from './ui';
import { refreshFiles } from './files-panel';
import { updateInputRows } from './convert-panel';
import { updateGenRows } from './generate-panel';

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
        // files before the failure did land; a refresh failure must not escape the
        // finally into the void-returning callers
        await refreshFiles().catch(() => showToast('Couldn\'t refresh the file list', true));
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
            genInput.value = lastSplat;
        }
        updateInputRows();
        void updateGenRows();
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
// Run it from Splat Studio's Generate tab with params like: width=16,height=16,scale=4
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
