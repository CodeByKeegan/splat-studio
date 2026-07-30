// Analyze panel: run the CLI --stats summary and render the persistent stats
// card (tiles + per-column table) parsed from the job log.
import * as api from './api';
import { $, analyzeInput, analyzeRun } from './dom';
import { showToast } from './ui';
import { runJob } from './jobs';

interface StatRow { col: string; min: string; max: string; median: string; mean: string; std: string; nans: string; infs: string; hist: string; }

// parse the CLI's --stats text output (job log): a "gaussians: N" header then a
// | Column | min | max | median | mean | stdDev | nans | infs | histogram | table
const parseSummary = (log: string): { rowCount: number; rows: StatRow[] } | null => {
    const rc = log.match(/^gaussians:\s*(\d+)/m);
    if (!rc) return null;
    const rows: StatRow[] = [];
    for (const line of log.split('\n')) {
        if (!line.trim().startsWith('|')) continue;
        const c = line.split('|').slice(1, -1).map((s) => s.trim());
        if (c.length < 9 || c[0] === 'Column' || /^-+$/.test(c[0])) continue;
        rows.push({ col: c[0], min: c[1], max: c[2], median: c[3], mean: c[4], std: c[5], nans: c[6], infs: c[7], hist: c[8] });
    }
    return rows.length ? { rowCount: Number(rc[1]), rows } : null;
};

const fmtNum = (s: string): string => {
    const n = Number(s);
    if (!Number.isFinite(n)) return s;
    if (n !== 0 && (Math.abs(n) >= 100000 || Math.abs(n) < 0.001)) return n.toPrecision(4);
    return String(Math.round(n * 1000) / 1000);
};

let lastSummaryMarkdown = '';
// render the persistent Analyze card from a summary job's --stats log
const renderSummaryCard = (name: string, log: string): void => {
    const result = $('analyze-result');
    const summary = parseSummary(log);
    if (!summary) { result.classList.add('hidden'); showToast('Could not parse summary output', true); return; }
    const head = log.search(/^gaussians:/m);
    lastSummaryMarkdown = (head >= 0 ? log.slice(head) : log).trim();
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
