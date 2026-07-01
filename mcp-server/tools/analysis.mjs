// Headless ANALYSIS / JOBS tools (not consent-gated): inspect, get_summary, jobs.
import { z } from 'zod';
import { apiGet, apiPost, qs } from '../http.mjs';
import { headless, sleep } from './_wrap.mjs';
import { ERR, okResult, failResult, mapHttpError, classifyJobFailure } from '../errors.mjs';

const POLL_MS = 700;

export function register(server) {
    server.registerTool('inspect', {
        title: 'Inspect',
        description:
            'Read quick, synchronous info. target="stats" -> gaussian count + x/y/z extents for one splat (needs project+input); "generator_params" -> a .mjs generator\'s advertised params (needs project+input); "gpus" -> GPU adapters [{index,name}]; "health" -> server + CLI status; "versions" -> app + splat-transform versions.',
        inputSchema: {
            target: z.enum(['stats', 'generator_params', 'gpus', 'health', 'versions']).describe('what to read'),
            project: z.string().optional().describe('Project name (required for stats / generator_params).'),
            input: z.string().optional().describe('Project-relative splat path (required for stats / generator_params).')
        }
    }, headless(async ({ target, project, input }) => {
        switch (target) {
            case 'stats':
                if (!project || !input) throw new Error('stats needs project and input');
                return await apiGet(`/api/stats${qs({ project, input })}`);
            case 'generator_params':
                if (!project || !input) throw new Error('generator_params needs project and input');
                return await apiGet(`/api/generator-params${qs({ project, input })}`);
            case 'gpus':
                return await apiGet('/api/gpus');
            case 'health':
                return await apiGet('/api/health');
            case 'versions':
                return await apiGet('/api/versions');
            default:
                throw new Error(`unknown target ${target}`);
        }
    }));

    server.registerTool('get_summary', {
        title: 'Get summary (job)',
        description:
            'Start an analysis-only summary job for a splat (per-column stats land in the JOB LOG; no file is written). Returns {jobId}; read the result with jobs(action="wait") then jobs(action="get").',
        inputSchema: {
            project: z.string(),
            input: z.string().describe('Project-relative splat path.')
        }
    }, headless(async ({ project, input }) => await apiPost('/api/summary', { project, input })));

    server.registerTool('jobs', {
        title: 'Jobs',
        description:
            'Inspect or control fire-and-poll jobs. action="list" -> all jobs (no logs); "get" -> one full job record incl log; "cancel" -> kill a running job; "wait" -> block until the job is done/error or the deadline (on timeout the job KEEPS RUNNING server-side; timeout != cancelled). Only the last ~50 finished jobs are retained.',
        inputSchema: {
            action: z.enum(['get', 'list', 'cancel', 'wait']),
            id: z.string().optional().describe('Job id (required for get / cancel / wait).'),
            timeout_ms: z.number().int().min(1000).max(3_600_000).optional().describe('wait deadline in ms (default 120000).')
        }
    }, async ({ action, id, timeout_ms }) => {
        try {
            if (action === 'list') return okResult(await apiGet('/api/jobs'));
            if (!id) return failResult({ error: ERR.BAD_INPUT, message: `id is required when action="${action}"` });
            if (action === 'get') return okResult(await apiGet(`/api/jobs/${encodeURIComponent(id)}`));
            if (action === 'cancel') return okResult(await apiPost(`/api/jobs/${encodeURIComponent(id)}/cancel`, {}));
            // wait: client-side poll (no server route)
            const deadline = Date.now() + (timeout_ms ?? 120_000);
            for (;;) {
                const job = await apiGet(`/api/jobs/${encodeURIComponent(id)}`);
                if (job.status === 'done') return okResult(job);
                if (job.status === 'error') return failResult(classifyJobFailure(job));
                if (Date.now() >= deadline) {
                    return failResult({
                        error: ERR.TIMEOUT,
                        message: `Job ${id} did not finish within ${timeout_ms ?? 120_000}ms — it is still running server-side.`
                    });
                }
                await sleep(POLL_MS);
            }
        } catch (e) {
            return failResult(mapHttpError(e));
        }
    });
}
