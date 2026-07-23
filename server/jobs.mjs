// Subprocess job runner: each GUI action becomes one polled job — optional
// pre-steps, a main CLI run, a finalize hook — with a capped log, an idle
// watchdog, cancellation, and a bounded finished-job history.
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

// drop the oldest finished jobs beyond the history cap
const pruneFinished = () => {
    const finished = [...jobs.values()].filter((j) => j.status !== 'running');
    for (let i = 0; i < finished.length - MAX_FINISHED_JOBS; i++) {
        jobs.delete(finished[i].id);
    }
};

const cancelledIds = new Set();

// Start a job (status 'running') and return it immediately; the step chain runs
// in the background and lands on 'done' | 'error' | 'cancelled'.
export const createJob = ({ title, args, command, cwd, expectedOutputs = [], viewables = [], preCommands = [], tempDirs = [], finalize, onOutputs, onStatus }) => {
    pruneFinished();
    const id = String(nextId++);
    const cliLine = (a) => `splat-transform ${a.slice(1).join(' ')}`;
    const job = {
        id,
        title,
        status: 'running',
        // non-CLI jobs (e.g. the PLY trim worker) pass a readable command label;
        // pre-steps (LOD pre-decimates) get their own line each
        command: command ?? [...preCommands.map((p) => cliLine(p.args)), cliLine(args)].join('\n'),
        log: '',
        outputs: [],
        viewables: [],
        startedAt: Date.now(),
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
        child.on('error', (err) => {
            clearTimeout(idleTimer);
            children.delete(id);
            reject(Object.assign(new Error(`Failed to launch: ${err.message}`), { launch: err }));
        });
        child.on('close', (code) => {
            clearTimeout(idleTimer);
            children.delete(id);
            if (code === 0) resolve();
            else reject(Object.assign(new Error(`Process exited with code ${code}`), { code }));
        });
    });

    // move the job to its terminal status; collects outputs only on 'done'
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
    };

    // Run the pre-decimate steps in order, then the main command. A failed or
    // cancelled step rejects and stops the chain, so the main step never runs on
    // a partial temp. Resolves to the job's terminal status.
    (async () => {
        for (const pre of preCommands) {
            if (cancelledIds.has(id)) return 'cancelled';
            await runStep(pre.args);
        }
        if (cancelledIds.has(id)) return 'cancelled';
        await runStep(args);
        // post-success hook before 'done'; a failure warns but doesn't fail the job
        if (finalize && !cancelledIds.has(id)) {
            try { await finalize(job); } catch (err) { append(`\nWarning: finalize failed: ${err?.message ?? err}\n`); }
        }
        return cancelledIds.has(id) ? 'cancelled' : 'done';
    })().then(finish).catch((e) => {
        // a step killed by cancelJob rejects too — that's a cancel, not an error
        if (cancelledIds.has(id)) return finish('cancelled');
        if (e?.launch) job.log += `\nFailed to launch: ${e.launch.message}\n`;
        else if (e?.code != null) job.log += `\nProcess exited with code ${e.code}\n`;
        finish('error');
    });

    return job;
};

export const getJob = (id) => jobs.get(id);

// kill a running job's current step and mark it for cancellation; false if not running
export const cancelJob = (id) => {
    const child = children.get(id);
    const job = jobs.get(id);
    if (!job || job.status !== 'running') return false;
    cancelledIds.add(id); // stop the step chain from advancing past the kill
    job.log += '\nCancelled by user\n';
    child?.kill(); // between steps there's no child — the chain checks cancelledIds
    return true;
};

// all jobs without their logs (the listing payload)
export const listJobs = () => [...jobs.values()].map(({ log, ...rest }) => rest);
