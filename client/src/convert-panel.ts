// Export (convert) panel: format-driven rows, encode-time filter options, the
// Export run, and the optional-filter row toggles shared with region-panel.
import * as api from './api';
import { $, convertInput, convertFormat, convertRun } from './dom';
import { showToast, panelValid } from './ui';
import { runJob } from './jobs';
import { filesRefreshHooks } from './files-panel';
import { currentGenParams } from './generate-panel';

const RUN_LABELS: Record<string, string> = {
    'sog': 'Export → SOG bundle',
    'sog-unbundled': 'Export → SOG folder',
    'ply': 'Export → PLY',
    'compressed-ply': 'Export → Compressed PLY',
    'spz': 'Export → SPZ',
    'glb': 'Export → GLB',
    'csv': 'Export → CSV',
    'html': 'Export → HTML viewer'
};

export const updateConvertRows = (): void => {
    const f = convertFormat.value;
    const isSog = f === 'sog' || f === 'sog-unbundled' || f === 'html';
    $('row-sog-encode').classList.toggle('hidden', !isSog);
    $('row-spz-version').classList.toggle('hidden', f !== 'spz');
    $('html-rows').classList.toggle('hidden', f !== 'html');
    if (!convertRun.disabled) convertRun.textContent = RUN_LABELS[f] ?? 'Export';
};
convertFormat.onchange = updateConvertRows;

// an .lcc / .lcc2 / lod-meta.json input reveals the LOD-select row
export const updateInputRows = (): void => {
    const lower = convertInput.value.toLowerCase();
    $('row-lod-select').classList.toggle('hidden', !(lower.endsWith('.lcc') || lower.endsWith('.lcc2') || lower.endsWith('lod-meta.json')));
};
convertInput.onchange = updateInputRows;
filesRefreshHooks.push(updateInputRows); // input rows track the file listing

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
            scratchDir: $<HTMLInputElement>('scratch-dir').value.trim(),
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

// Reveal each optional filter's inputs only when its checkbox is on. The region
// pair lives on the Collision panel — region-panel registers those listeners so
// its listener order (row-toggle → seeding → estimate) is preserved.
const ACTION_TOGGLES: [string, string][] = [
    ['filter-value-on', 'filter-value-rows'],
    ['filter-floaters-on', 'filter-floaters-rows'],
    ['region-box-on', 'region-box-rows'],
    ['region-sphere-on', 'region-sphere-rows']
];
export const syncActionRows = (): void => {
    for (const [cb, rows] of ACTION_TOGGLES) $(rows).classList.toggle('hidden', !$<HTMLInputElement>(cb).checked);
};
for (const cb of ['filter-value-on', 'filter-floaters-on']) $(cb).addEventListener('change', syncActionRows);
syncActionRows();
