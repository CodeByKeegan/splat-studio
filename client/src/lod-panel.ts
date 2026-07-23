// LOD panel: decimate/combine level rows, the auto-tune planner, and the bake
// run for a streamed multi-LOD SOG.
import * as api from './api';
import { $, lodInput } from './dom';
import { splatFileNames } from './state';
import { showToast, fmtCount, baseLabel, panelValid } from './ui';
import { runJob } from './jobs';
import { fillSelect, filesRefreshHooks } from './files-panel';

const lodMode = $<HTMLSelectElement>('lod-mode');
const lodFileRows = $<HTMLDivElement>('lod-file-rows');
const lodRun = $<HTMLButtonElement>('lod-run');

const lodRowSelects = (): HTMLSelectElement[] => [...lodFileRows.querySelectorAll('select')];
// refill the level-row selects whenever the file list refreshes
filesRefreshHooks.push(() => { for (const s of lodRowSelects()) fillSelect(s, splatFileNames); });

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

// LOD panel: decimate vs combine swaps which level controls show
export const updateLodRows = (): void => {
    const combine = lodMode.value === 'combine';
    $('row-lod-levels').classList.toggle('hidden', combine);
    $('row-lod-files').classList.toggle('hidden', !combine);
    if (combine && lodFileRows.children.length === 0) addLodRow();
};
lodMode.onchange = updateLodRows;

// ----- LOD auto-tune: fill the LOD settings from each source's gaussian count + extents -----
const lodAutotuneBtn = $<HTMLButtonElement>('lod-autotune');
const lodAutotunePlan = $('lod-autotune-plan');
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
    lodAutotuneBtn.disabled = true;
    const prevLabel = lodAutotuneBtn.textContent;
    lodAutotuneBtn.textContent = 'Reading stats…';
    const run = lodMode.value === 'combine' ? autotuneCombine(input) : autotuneDecimate(input);
    void run.catch((err) => showToast(`Auto-tune failed: ${err}`, true))
        .finally(() => {
            lodAutotuneBtn.disabled = false;
            lodAutotuneBtn.textContent = prevLabel;
        });
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
            scratchDir: $<HTMLInputElement>('scratch-dir').value.trim(),
            lodFiles,
            lodEnvFlags
        }
    }), lodRun, $<HTMLInputElement>('lod-autoload').checked);
};
