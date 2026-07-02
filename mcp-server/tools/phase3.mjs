// Phase 3 — opinionated layer + the MCP resource surface.
//  - suggest_lod_settings: recommend streamed-LOD settings from a splat's stats.
//  - resources: live read-only listings (projects / jobs / files) as MCP resources.
import { z } from 'zod';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
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

    // ---- MCP resources: live read-only listings ----
    const json = (uri, data) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] });

    server.registerResource(
        'projects', 'splat-studio://projects',
        { title: 'Projects', description: 'Workspace projects', mimeType: 'application/json' },
        async (uri) => json(uri, await apiGet('/api/projects'))
    );

    server.registerResource(
        'jobs', 'splat-studio://jobs',
        { title: 'Jobs', description: 'All jobs (without logs)', mimeType: 'application/json' },
        async (uri) => json(uri, await apiGet('/api/jobs'))
    );

    server.registerResource(
        'files', new ResourceTemplate('splat-studio://files/{project}', { list: undefined }),
        { title: 'Project files', description: 'Primary assets in a project', mimeType: 'application/json' },
        async (uri, { project }) => json(uri, await apiGet(`/api/files${qs({ project: decodeURIComponent(String(project)) })}`))
    );

    // ---- MCP prompts: canned multi-step workflows ----
    const userMsg = (text) => ({ messages: [{ role: 'user', content: { type: 'text', text } }] });

    server.registerPrompt('optimize_for_web', {
        title: 'Optimize a splat for the web',
        description: 'Pick and run the best web-ready output for a splat (SOG bundle, or streamed LOD for big scenes).',
        argsSchema: { project: z.string(), input: z.string() }
    }, ({ project, input }) => userMsg(
        `Optimize the splat "${input}" in project "${project}" for web delivery.\n` +
        `1) inspect(target:"stats", project:"${project}", input:"${input}") to read its gaussian count + extents.\n` +
        `2) If it is large (>~2M gaussians or wide extents): suggest_lod_settings then build_lod(mode:"decimate", ...the suggestion). Otherwise convert(format:"sog").\n` +
        `3) jobs(action:"wait", id, timeout_ms) on the returned jobId, then jobs(action:"get", id) and report the output path + size.`
    ));

    server.registerPrompt('setup_collision', {
        title: 'Generate a collision mesh',
        description: 'Voxelize a splat into a collision mesh, with a seed point + carve capsule, guarding against the vertex-limit overflow.',
        argsSchema: { project: z.string(), input: z.string() }
    }, ({ project, input }) => userMsg(
        `Generate a collision mesh for "${input}" in project "${project}".\n` +
        `1) generate_collision(project:"${project}", input:"${input}") with a sensible voxelSize (start 0.05), optionally seedPos (voxel space: viewer [x,y,z] -> [-x,y,-z]; [0,1,0] = 1m above the floor) and carve {height,radius}.\n` +
        `2) If it returns {refused:true}, raise voxelSize or set filterBox/filterSphere to crop the region (read the preflight estimate), then retry — or pass overridePreflight:true only if you accept the crash risk.\n` +
        `3) jobs(action:"wait", id), then report the collision.collision.glb output. GPU is required; a missing GPU surfaces as gpu-required.`
    ));

    server.registerPrompt('clean_up_scan', {
        title: 'Clean up a noisy scan',
        description: 'Remove floaters, NaN gaussians, and out-of-bounds junk from a raw capture, writing a cleaned .ply.',
        argsSchema: { project: z.string(), input: z.string() }
    }, ({ project, input }) => userMsg(
        `Clean up the raw scan "${input}" in project "${project}".\n` +
        `1) inspect(target:"stats") for the extents; if the scene has distant junk, plan a keep-region around the subject.\n` +
        `2) convert(project:"${project}", input:"${input}", format:"ply", filterNaN:true, filterFloaters:{}) — floater removal is GPU-only: with device:"cpu" it is rejected as bad-input, with no usable GPU the job fails as gpu-required. Either way, drop filterFloaters and rely on filterValue {column:"opacity", comparator:"gt", value:0.05} instead.\n` +
        `3) If junk remains, trim_region(mode:"keep", box:[...]) around the subject (SPLAT frame: viewer [x,y,z] -> [x,-y,-z]).\n` +
        `4) jobs(action:"wait") each step; report before/after gaussian counts via inspect(target:"stats").`
    ));

    server.registerPrompt('scale_to_real_world', {
        title: 'Scale a splat to real-world units',
        description: 'Use the live editor to measure a known span, then apply the derived scale headlessly (requires editor consent).',
        argsSchema: { project: z.string(), input: z.string() }
    }, ({ project, input }) => userMsg(
        `Scale "${input}" in project "${project}" to real-world meters using a known reference length.\n` +
        `1) inspect(target:"editor_status") — needs {connected:true, controlEnabled:true}; if control is off, ask the user to enable it in Settings.\n` +
        `2) load_into_viewport(action:"load", project:"${project}", file:"${input}"), then open the Edit panel: panel(action:"open", id:"panel-edit").\n` +
        `3) Place A/B on a feature of known size: measure(action:"measure", points:[[ax,ay,az],[bx,by,bz]]) — passing points also turns measure mode on (viewport_click only places markers after that); confirm with viewport_screenshot(max_width:800).\n` +
        `4) measure(action:"set_length", length:<real meters>), then measure(action:"measure") -> read {scale}.\n` +
        `5) Apply headlessly: convert(project:"${project}", input:"${input}", format:"ply", scale:<scale>), jobs(action:"wait"), and report the output.`
    ));

    server.registerPrompt('inspect_splat', {
        title: 'Inspect a splat',
        description: 'Summarize a splat: gaussian count, extents, and per-column stats.',
        argsSchema: { project: z.string(), input: z.string() }
    }, ({ project, input }) => userMsg(
        `Inspect "${input}" in project "${project}".\n` +
        `1) inspect(target:"stats", project:"${project}", input:"${input}") for count + x/y/z extents.\n` +
        `2) get_summary(project:"${project}", input:"${input}") then jobs(action:"wait", id) and jobs(action:"get", id) — the per-column stats table is in the job log.\n` +
        `3) Summarize the size, extents, and anything notable (NaNs, opacity distribution).`
    ));
}
