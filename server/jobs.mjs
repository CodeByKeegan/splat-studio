import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const jobs = new Map();
const children = new Map();
let nextId = 1;

const MAX_LOG = 200_000;
const MAX_FINISHED_JOBS = 50;
// Reap a job only after this long with NO output — a stall, not a long-but-healthy
// run. Streamed-LOD bakes on large scenes legitimately run 1h+ while emitting a
// chunk every few seconds. Override with SPLAT_JOB_IDLE_TIMEOUT_MS.
const IDLE_TIMEOUT_MS = Number(process.env.SPLAT_JOB_IDLE_TIMEOUT_MS) || 10 * 60 * 1000;

// How many jobs may run at once; the rest wait in a FIFO queue. One GPU:
// concurrent GPU-heavy jobs (collision, cluster filter) multiply the TDR risk,
// so the default is serial. Raise via the Jobs panel or SPLAT_JOB_CONCURRENCY.
const MAX_CONCURRENCY = 8;
const clampConcurrency = (n) => Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(n)));
let concurrency = clampConcurrency(Number(process.env.SPLAT_JOB_CONCURRENCY) || 1);

export const getConcurrency = () => concurrency;
export const setConcurrency = (n) => {
    if (!Number.isFinite(n)) throw new Error('concurrency must be a number');
    concurrency = clampConcurrency(n);
    pump(); // a raised cap frees slots for queued jobs
    return concurrency;
};

const pruneFinished = () => {
    const finished = [...jobs.values()].filter((j) => j.status === 'done' || j.status === 'error');
    for (let i = 0; i < finished.length - MAX_FINISHED_JOBS; i++) {
        jobs.delete(finished[i].id);
    }
};

const cancelledIds = new Set();

// FIFO of { id, start } waiting for a free slot
const queue = [];
let running = 0;

const pump = () => {
    while (running < concurrency && queue.length) {
        const next = queue.shift();
        if (cancelledIds.has(next.id)) { cancelledIds.delete(next.id); continue; }
        running++;
        next.start();
    }
};

export const createJob = ({ title, args, command, cwd, expectedOutputs = [], viewables = [], preCommands = [], tempDirs = [], finalize, onOutputs, onStatus }) => {
    pruneFinished();
    const id = String(nextId++);
    const cliLine = (a) => `splat-transform ${a.slice(1).join(' ')}`;
    const job = {
        id,
        title,
        status: 'queued',
        // non-CLI jobs (e.g. the PLY trim worker) pass a readable command label;
        // pre-steps (LOD pre-decimates) get their own line each
        command: command ?? [...preCommands.map((p) => cliLine(p.args)), cliLine(args)].join('\n'),
        log: '',
        outputs: [],
        viewables: [],
        queuedAt: Date.now(),
        startedAt: null,
        endedAt: null
    };
    jobs.set(id, job);

    // Idle watchdog: reap a job only after IDLE_TIMEOUT_MS with no output. A
    // healthy job (even a multi-hour LOD bake) keeps printing progress, so this
    // fires only on a genuine stall — never on a job that's merely slow.
    let idleTimer;
    let lastOutputAt = Date.now();
    const append = (chunk) => {
        lastOutputAt = Date.now();
        job.log += chunk.toString();
        if (job.log.length > MAX_LOG) job.log = `…(truncated)\n${job.log.slice(-MAX_LOG / 2)}`;
    };

    // Run one CLI step to completion. Resolves on exit code 0, rejects otherwise.
    // process.execPath is a real Node binary in every mode — `node` in dev, the
    // bundled node.exe in the packaged app (the Electron main process launches
    // the server with it, not via ELECTRON_RUN_AS_NODE, because the CLI's native
    // WebGPU/Dawn device crashes when hosted inside the Electron binary).
    const runStep = (stepArgs) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, stepArgs, { cwd, windowsHide: true });
        children.set(id, child);
        const arm = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                const mins = Math.round((Date.now() - lastOutputAt) / 60000);
                job.log += `\nNo output for ${mins} min — process appears stuck, killing it.\n`;
                child.kill();
            }, IDLE_TIMEOUT_MS);
        };
        arm();
        const onData = (chunk) => { append(chunk); arm(); };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', (err) => { clearTimeout(idleTimer); children.delete(id); reject({ launch: err }); });
        child.on('close', (code) => {
            clearTimeout(idleTimer);
            children.delete(id);
            if (code === 0) resolve();
            else reject({ code });
        });
    });

    const finish = (status) => {
        if (job.status !== 'running') return;
        if (status === 'done') {
            const exists = (rel) => fs.existsSync(path.join(cwd, ...rel.split('/')));
            job.outputs = expectedOutputs.filter(exists);
            job.viewables = viewables.filter((v) => exists(v.name));
        }
        // best-effort: clear temp scratch dirs (e.g. pre-decimated LOD sources)
        for (const d of tempDirs) {
            try { fs.rmSync(path.join(cwd, ...d.split('/')), { recursive: true, force: true }); } catch { /* ignore */ }
        }
        cancelledIds.delete(id);
        job.status = status;
        job.endedAt = Date.now();
        if (status === 'done') onOutputs?.(job.outputs);
        onStatus?.(job);
        running--;
        pump();
    };

    // Run the pre-decimate steps in order, then the main command. A failed or
    // cancelled step rejects and stops the chain, so the main step never runs on
    // a partial temp.
    const start = () => {
        job.status = 'running';
        job.startedAt = Date.now();
        lastOutputAt = Date.now();
        onStatus?.(job);
        (async () => {
            for (const pre of preCommands) {
                if (cancelledIds.has(id)) return;
                await runStep(pre.args);
            }
            if (cancelledIds.has(id)) return;
            await runStep(args);
            // post-success hook before 'done'; a failure warns but doesn't fail the job
            if (finalize && !cancelledIds.has(id)) {
                try { await finalize(job); } catch (err) { append(`\nWarning: finalize failed: ${err?.message ?? err}\n`); }
            }
        })().then(() => finish('done')).catch((e) => {
            if (e?.launch) job.log += `\nFailed to launch: ${e.launch.message}\n`;
            else if (e?.code != null) job.log += `\nProcess exited with code ${e.code}\n`;
            finish('error');
        });
    };
    queue.push({ id, start });
    pump();

    return job;
};

export const getJob = (id) => jobs.get(id);

export const cancelJob = (id) => {
    const job = jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
        // never started: pump() skips it via cancelledIds and drops the marker
        cancelledIds.add(id);
        job.log += 'Cancelled while queued\n';
        job.status = 'error';
        job.endedAt = Date.now();
        return true;
    }
    if (job.status !== 'running') return false;
    cancelledIds.add(id); // stop the step chain from advancing past the kill
    job.log += '\nCancelled by user\n';
    children.get(id)?.kill();
    return true;
};

export const listJobs = () => [...jobs.values()].map(({ log, ...rest }) => rest);
