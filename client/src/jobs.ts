// Jobs panel: the server-side job queue list + detail view, the shared poller,
// and runJob — submit a CLI job, await completion, refresh + auto-load outputs.
import * as api from './api';
import { $, jobCommand, jobLog } from './dom';
import { showToast } from './ui';
import { refreshFiles, viewFile } from './files-panel';

const jobList = $<HTMLUListElement>('job-list');
const jobParallel = $<HTMLInputElement>('job-parallel');

/** every visible number input in the panel must hold a valid value */
export const panelValid = (panelId: string): boolean => {
    for (const input of document.querySelectorAll<HTMLInputElement>(`#${panelId} input[type=number]`)) {
        if (input.closest('.hidden')) continue;
        if (!input.reportValidity()) return false;
    }
    return true;
};

// Jobs queue server-side (FIFO, concurrency-capped) — the panel lists them all,
// with the selected job's command + log shown below the list.
let selectedJobId: string | null = null;
let jobsCache: api.JobSummary[] = [];

const fmtDuration = (ms: number): string => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

// skip the (potentially 200 KB) log rewrite + forced relayout when nothing changed
let lastDetail = '';
const renderJobDetail = (job: api.Job): void => {
    const key = `${job.id}:${job.status}:${job.log.length}`;
    if (key === lastDetail) return;
    lastDetail = key;
    jobCommand.textContent = job.command;
    jobLog.textContent = job.status === 'queued' ? 'Waiting for a free slot…' : job.log;
    jobLog.scrollTop = jobLog.scrollHeight;
};

const selectJob = (id: string): void => {
    selectedJobId = id;
    renderJobList();
    // one-shot fetch so finished rows show their detail; active rows stay fresh via the poller
    void api.getJob(id).then((j) => { if (selectedJobId === id) renderJobDetail(j); }).catch(() => { /* pruned */ });
};

const renderJobList = (): void => {
    jobList.innerHTML = '';
    // newest first — the row you just queued lands on top
    for (const j of [...jobsCache].sort((a, b) => Number(b.id) - Number(a.id))) {
        const li = document.createElement('li');
        li.className = `job-row${j.id === selectedJobId ? ' selected' : ''}`;
        const badge = document.createElement('span');
        badge.className = `badge ${j.status}`;
        badge.textContent = j.status;
        const title = document.createElement('span');
        title.className = 'job-row-title';
        title.textContent = j.title;
        title.title = j.title;
        const time = document.createElement('span');
        time.className = 'job-row-time';
        if (j.startedAt != null) time.textContent = fmtDuration((j.endedAt ?? Date.now()) - j.startedAt);
        li.append(badge, title, time);
        if (api.isJobActive(j)) {
            const cancel = document.createElement('button');
            cancel.className = 'job-row-cancel';
            cancel.textContent = '✕';
            cancel.title = j.status === 'queued' ? 'Remove from the queue' : 'Kill the running splat-transform process';
            cancel.onclick = (e) => {
                e.stopPropagation();
                void api.cancelJob(j.id).catch((err) => showToast(`Cancel failed: ${err}`, true));
            };
            li.append(cancel);
        }
        li.onclick = () => selectJob(j.id);
        jobList.append(li);
    }
};

// One shared poller owns all Jobs-panel refreshes while anything is queued or
// running: the list, the selected job's detail, and the completion waiters that
// runJob awaits. It also catches jobs submitted outside the GUI (MCP).
const jobWaiters = new Map<string, (job: api.Job) => void>();
let jobsPolling = false;
const pollJobs = async (): Promise<boolean> => {
    const { jobs, concurrency } = await api.getJobs();
    jobsCache = jobs;
    if (document.activeElement !== jobParallel) jobParallel.value = String(concurrency);
    renderJobList();
    // settle waiters for jobs that finished (or were pruned before we saw it)
    for (const [id, resolve] of [...jobWaiters]) {
        const j = jobs.find((x) => x.id === id);
        if (j && api.isJobActive(j)) continue;
        jobWaiters.delete(id);
        resolve(await api.getJob(id));
    }
    if (selectedJobId) {
        // refresh the detail while the selected job moves, incl. its final transition;
        // a settled-and-rendered selection costs nothing further
        const sel = jobs.find((j) => j.id === selectedJobId);
        if (sel && (api.isJobActive(sel) || !lastDetail.startsWith(`${sel.id}:${sel.status}`))) {
            renderJobDetail(await api.getJob(selectedJobId));
        }
    }
    return jobWaiters.size > 0 || jobs.some(api.isJobActive);
};
export const ensureJobsPolling = (): void => {
    if (jobsPolling) return;
    jobsPolling = true;
    void (async () => {
        try {
            while (await pollJobs()) await new Promise((r) => setTimeout(r, 700));
        } catch { /* server gone — the next submit restarts the poller */ }
        jobsPolling = false;
    })();
};
const waitForJob = (id: string): Promise<api.Job> =>
    new Promise((resolve) => { jobWaiters.set(id, resolve); ensureJobsPolling(); });

jobParallel.onchange = () => {
    void api.setJobConcurrency(Number(jobParallel.value))
        .then((n) => { jobParallel.value = String(n); })
        .catch((err) => showToast(`Couldn't set parallel jobs: ${err}`, true));
};

// Fan-out flows own their button's disabled state for the whole run and pass no
// button here; single-shot buttons are disabled only while the submit is in flight.
export const runJob = async (start: () => Promise<string>, button?: HTMLButtonElement, autoLoad = true): Promise<api.Job | undefined> => {
    let jobId: string;
    if (button) button.disabled = true;
    try {
        jobId = await start();
    } catch (err) {
        showToast(`Couldn't start job: ${err}`, true);
        return undefined;
    } finally {
        if (button) button.disabled = false;
    }
    selectJob(jobId);
    try {
        const job = await waitForJob(jobId);
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
            showToast(`${job.title} — failed: ${lastLine?.slice(0, 160) ?? 'see the Jobs panel log'}`, true);
        }
        return job;
    } catch (err) {
        showToast(`Lost track of job: ${err}`, true);
        return undefined;
    }
};
