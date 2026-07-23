// Generate panel: schema-driven sliders (or a freeform params field) for the
// selected .mjs generator, plus the debounced generate-and-view preview flow.
import * as api from './api';
import { $, genInput, generateViewBtn } from './dom';
import { showToast } from './ui';
import { runJob } from './jobs';
import { fileActionCallbacks } from './files-panel';

// live sliders when the generator advertises a `params` schema, else freeform
let genSchema: api.GenParam[] | null = null;
let genSchemaFor = '';

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

export const currentGenParams = (): string => {
    if (genSchema && genSchemaFor === genInput.value) {
        return [...$('gen-sliders').querySelectorAll<HTMLInputElement>('input[type=range]')]
            .map((i) => `${i.dataset.name}=${i.value}`).join(',');
    }
    return $<HTMLInputElement>('convert-params').value.trim();
};

// Generate panel: schema-driven sliders (or a freeform params field) for the
// selected .mjs generator
export const updateGenRows = async (): Promise<void> => {
    const input = genInput.value;
    if (!input.toLowerCase().endsWith('.mjs')) {
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
genInput.onchange = () => void updateGenRows();

let genPreviewBusy = false;
const doGenerateView = (): void => {
    const input = genInput.value;
    if (!input.toLowerCase().endsWith('.mjs')) { showToast('Pick a .mjs generator in the Generate tab', true); return; }
    if (genPreviewBusy) { scheduleGenPreview(); return; } // coalesce slider spam into one queued job
    genPreviewBusy = true;
    void runJob(() => api.startConvert({ input, format: 'ply', options: { params: currentGenParams() } }), generateViewBtn)
        .finally(() => { genPreviewBusy = false; });
};
let genPreviewTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleGenPreview(): void {
    clearTimeout(genPreviewTimer);
    genPreviewTimer = setTimeout(doGenerateView, 250);
}
generateViewBtn.onclick = doGenerateView;
// the files context menu's "Generate & view" action
fileActionCallbacks.generateView = () => void updateGenRows().then(() => generateViewBtn.click());
