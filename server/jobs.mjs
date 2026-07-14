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

const pruneFinished = () => {
    const finished = [...jobs.values()].filter((j) => j.status !== 'running');
    for (let i = 0; i < finished.length - MAX_FINISHED_JOBS; i++) {
        jobs.delete(finished[i].id);
    }
};

// `steps`: a job normally runs one CLI invocation (`args`), but some pipelines
// need several run in sequence under one job id/log (e.g. streamed-LOD decimate
// mode: v3.0.0 requires --decimate to be a pipeline's final action with a .ply
// output, so each level is decimated in its own invocation before a final
// invocation tags and combines them). Pass `steps: [args, args, ...]` instead
// of `args` for that; steps run in order and stop at the first failure.
// `cleanupFiles`: relative paths deleted (best-effort) once the job ends —
// scratch files a multi-step pipeline produced that aren't part of the result.
export const createJob = ({ title, args, steps, command, cwd, expectedOutputs = [], viewables = [], cleanupFiles = [], onOutputs, onStatus }) => {
    pruneFinished();
    const id = String(nextId++);
    const stepsList = steps ?? [args];
    const job = {
        id,
        title,
        status: 'running',
        // non-CLI jobs (e.g. the PLY trim worker) pass a readable command label
        command: command ?? stepsList.map((a) => `splat-transform ${a.slice(1).join(' ')}`).join(' && '),
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
    const armIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            const mins = Math.round((Date.now() - lastOutputAt) / 60000);
            job.log += `\nNo output for ${mins} min — process appears stuck, killing it.\n`;
            children.get(id)?.kill();
        }, IDLE_TIMEOUT_MS);
    };
    armIdleTimer();

    const append = (chunk) => {
        lastOutputAt = Date.now();
        armIdleTimer();
        job.log += chunk.toString();
        if (job.log.length > MAX_LOG) job.log = `…(truncated)\n${job.log.slice(-MAX_LOG / 2)}`;
    };

    const finish = (status) => {
        clearTimeout(idleTimer);
        children.delete(id);
        for (const rel of cleanupFiles) {
            try { fs.rmSync(path.join(cwd, ...rel.split('/')), { force: true }); } catch { /* best-effort */ }
        }
        job.status = status;
        if (status === 'done') {
            const exists = (rel) => fs.existsSync(path.join(cwd, ...rel.split('/')));
            job.outputs = expectedOutputs.filter(exists);
            job.viewables = viewables.filter((v) => exists(v.name));
        }
        job.endedAt = Date.now();
        if (status === 'done') onOutputs?.(job.outputs);
        onStatus?.(job);
    };

    // process.execPath is a real Node binary in every mode — `node` in dev, the
    // bundled node.exe in the packaged app (the Electron main process launches
    // the server with it, not via ELECTRON_RUN_AS_NODE, because the CLI's native
    // WebGPU/Dawn device crashes when hosted inside the Electron binary).
    const runStep = (i) => {
        const child = spawn(process.execPath, stepsList[i], { cwd, windowsHide: true });
        children.set(id, child);
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        child.on('error', (err) => {
            job.log += `\nFailed to launch: ${err.message}\n`;
            finish('error');
        });
        child.on('close', (code) => {
            if (job.status !== 'running') return; // already handled by an 'error' event
            if (code !== 0) {
                job.log += `\nProcess exited with code ${code}\n`;
                return finish('error');
            }
            if (i + 1 < stepsList.length) runStep(i + 1);
            else finish('done');
        });
    };
    runStep(0);

    return job;
};

export const getJob = (id) => jobs.get(id);

export const cancelJob = (id) => {
    const child = children.get(id);
    if (!child) return false;
    const job = jobs.get(id);
    if (job) job.log += '\nCancelled by user\n';
    child.kill();
    return true;
};

export const listJobs = () => [...jobs.values()].map(({ log, ...rest }) => rest);
