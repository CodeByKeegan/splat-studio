// Advisory tools: recommendations derived from a splat's stats.
import { z } from 'zod';
import { apiGet, qs } from '../http.mjs';
import { headless, RO } from './_wrap.mjs';

export function register(server) {
    server.registerTool('suggest_lod_settings', {
        title: 'Suggest LOD settings',
        description:
            'Recommend streamed-LOD settings (decimate mode) for a splat from its gaussian count + extents. Reads the cached stats; returns a suggestion you can pass straight to build_lod(mode="decimate").',
        annotations: RO,
        inputSchema: { project: z.string(), input: z.string().describe('Project-relative splat path.') }
    }, headless(async ({ project, input }) => {
        const { count, extents } = await apiGet(`/api/stats${qs({ project, input })}`);
        const maxExt = Math.max(1, ...(Array.isArray(extents) ? extents.filter(Number.isFinite) : []));
        const lodLevels = count > 5_000_000 ? 4 : count > 1_000_000 ? 3 : 2;
        const lodKeepPercent = count > 5_000_000 ? 40 : 50;
        const lodChunkCount = count > 8_000_000 ? 256 : 512;
        const lodChunkExtent = Math.min(1000, Math.max(8, Math.round(maxExt / 4)));
        return {
            count,
            extents,
            suggestion: { mode: 'decimate', lodLevels, lodKeepPercent, lodChunkCount, lodChunkExtent },
            rationale: `~${count.toLocaleString()} gaussians, max extent ${maxExt.toFixed(1)}m → ${lodLevels} levels at ${lodKeepPercent}% keep, ~${lodChunkExtent}m chunks. Pass these to build_lod(mode="decimate").`
        };
    }));
}
