// EDITOR tools (consent-gated). Each forwards a command to the running GUI via
// POST /api/editor/command (the relay correlates + the client bridge dispatches
// through the real main.ts actions, so gizmos + form fields + persistence all
// update together). All are gated by the MCP consent toggle (control-disabled
// when off) and return no-editor when the app isn't connected.
import { z } from 'zod';
import { apiPost } from '../http.mjs';
import { okResult, failResult, imageResult, mapEditorError } from '../errors.mjs';
import { RO, SAFE } from './_wrap.mjs';

// call an editor command; resolves to data, or throws an {error,message}
async function callEditor(name, params) {
    let r;
    try {
        r = await apiPost('/api/editor/command', { name, params: params ?? {} });
    } catch (e) {
        throw mapEditorError(e); // 409 no-editor / 403 control-disabled / 504 timeout / 400 bad-input
    }
    if (r && r.error) throw { error: r.error, message: r.message }; // 200 with a tool-level ok:false
    return r?.data;
}

// wrap an editor handler into a CallToolResult
const editor = (fn) => async (args) => {
    try {
        return okResult(await fn(args));
    } catch (e) {
        return failResult(e && e.error ? e : { error: 'bad-input', message: e?.message || String(e) });
    }
};

const vec3 = z.array(z.number()).length(3);
const boxArr = z.array(z.union([z.number(), z.literal(''), z.literal('-')])).length(6);
const sphereArr = z.array(z.number()).length(4);

export function register(server) {
    // ---- viewport ----
    server.registerTool('camera', {
        title: 'Camera',
        description:
            'Read or drive the live viewport camera (VIEWER-WORLD frame). action="get" -> {eye,target,...}; "set" needs eye+target; "frame" frames the scene; "mode" switches fly/orbit.',
        annotations: SAFE,
        inputSchema: {
            action: z.enum(['get', 'set', 'mode', 'frame']),
            eye: vec3.optional().describe('camera position [x,y,z] (set).'),
            target: vec3.optional().describe('look-at point [x,y,z] (set).'),
            mode: z.enum(['fly', 'orbit']).optional().describe('camera control mode (action="mode").')
        }
    }, editor(async (args) => await callEditor('camera', args)));

    server.registerTool('viewport_screenshot', {
        title: 'Viewport screenshot',
        description: 'Capture a PNG of the main viewport camera and return it as an image. Default max width 1920; pass max_width to downscale (e.g. 800 for a quick look — smaller is cheaper for the model).',
        annotations: RO,
        inputSchema: {
            max_width: z.number().int().min(64).max(1920).optional().describe('Cap the image width in px (aspect preserved).')
        }
    }, async ({ max_width }) => {
        try {
            const data = await callEditor('viewport_screenshot', max_width ? { maxWidth: max_width } : {});
            return imageResult(data.png, { width: data.width, height: data.height });
        } catch (e) {
            return failResult(e && e.error ? e : { error: 'bad-input', message: e?.message || String(e) });
        }
    });

    server.registerTool('viewport_click', {
        title: 'Viewport click',
        description:
            'Pick the front splat surface at normalized viewport coords (x,y in 0..1). Returns the picked point in VIEWER-WORLD space, or {hit:false}. Places the active edit marker ONLY while a measure/origin tool is on (enable one first via measure(points) or set_origin); otherwise it is just a click.',
        annotations: SAFE,
        inputSchema: {
            x: z.number().min(0).max(1).describe('horizontal fraction (0=left, 1=right).'),
            y: z.number().min(0).max(1).describe('vertical fraction (0=top, 1=bottom).')
        }
    }, editor(async (args) => await callEditor('viewport_click', args)));

    server.registerTool('load_into_viewport', {
        title: 'Load into viewport',
        description: 'action="load" loads a file from the app\'s CURRENT project (a viewable splat/collision/voxel) into the 3D viewport; "clear" empties it. The viewport cannot load across projects — if project is given and differs from the current one (see get_editor_state.project), this errors.',
        annotations: SAFE,
        inputSchema: {
            action: z.enum(['load', 'clear']),
            project: z.string().optional().describe('must match the app\'s current project when given.'),
            file: z.string().optional().describe('project-relative file (required for load).')
        }
    }, editor(async (args) => await callEditor('load_into_viewport', args)));

    server.registerTool('select_item', {
        title: 'Select item',
        description: 'Select a scene-hierarchy item by id (or pass id:null to clear the selection), raising its gizmo. Use get_editor_state to list selectable items.',
        annotations: SAFE,
        inputSchema: { id: z.string().nullable().describe('scene item id, or null to deselect.') }
    }, editor(async (args) => await callEditor('select_item', args)));

    server.registerTool('get_editor_state', {
        title: 'Get editor state',
        description:
            'Snapshot the live editor: current project, loaded splat, active panels, selection + the selectable scene item ids (for select_item), active edit tool (none|measure|origin), layer visibility, and camera. Use this for editor reads instead of separate getters.',
        annotations: RO,
        inputSchema: {}
    }, editor(async () => await callEditor('get_editor_state', {})));

    // ---- scene display ----
    server.registerTool('set_view_option', {
        title: 'Set view option',
        description:
            'Toggle a viewport display option. option="bounds" (value bool); "skybox" (value = a project image file name, or null to clear); "collision_style" (value xray|hidden|solid); "layer" (target splat|collision|voxels, value bool).',
        annotations: SAFE,
        inputSchema: {
            option: z.enum(['bounds', 'skybox', 'collision_style', 'layer']),
            value: z.union([z.boolean(), z.string(), z.null()]).optional(),
            target: z.enum(['splat', 'collision', 'voxels']).optional().describe('which layer (option="layer").')
        }
    }, editor(async (args) => await callEditor('set_view_option', args)));

    // ---- edit tools (gizmos) ----
    server.registerTool('measure', {
        title: 'Measure',
        description:
            'Measure-to-scale tool. action="measure" -> {a, b, distance, scale?} — the current A/B marker positions (viewer-world), their span in world units, and (if a real length is set) the scale factor to pass to convert(scale). action="set_length" sets the real-world A-B length (m). Passing points also turns measure mode on: two points set A then B; a single point sets whichever marker is ACTIVE (A first, alternating). Subsequent viewport_click calls place markers too, once measure mode is on.',
        annotations: SAFE,
        inputSchema: {
            action: z.enum(['measure', 'set_length']),
            length: z.number().positive().optional().describe('real A-B length in meters (action="set_length").'),
            points: z.array(vec3).min(1).max(2).optional().describe('viewer-world positions: [A,B] sets both; a single [p] sets the active marker (action="measure").')
        }
    }, editor(async (args) => await callEditor('measure', args)));

    server.registerTool('set_origin', {
        title: 'Set origin',
        description:
            'Turn on origin mode and optionally place the origin point. Returns {translate} — the SPLAT-frame translate that recenters the splat there; pass it to convert(format:"ply", translate) to apply headlessly. Provide a viewer-world point, or omit and place it with viewport_click.',
        annotations: SAFE,
        inputSchema: { point: vec3.optional().describe('viewer-world point to make the new origin.') }
    }, editor(async (args) => await callEditor('set_origin', args)));

    server.registerTool('set_region', {
        title: 'Set region',
        description:
            'Set a viewport region gizmo. target="crop_box"/"crop_sphere" drive the Edit-panel crop/carve region; target="collision_region" drives the Collision-panel region. All three are the SPLAT frame (viewer [x,y,z] -> [x,-y,-z]) — the same numbers convert/trim_region/generate_collision take. gizmoMode switches move/resize on the collision region.',
        annotations: SAFE,
        inputSchema: {
            target: z.enum(['crop_box', 'crop_sphere', 'collision_region']),
            box: boxArr.optional().describe('[minX,minY,minZ,maxX,maxY,maxZ]; "" or "-" = unbounded side.'),
            sphere: sphereArr.optional().describe('[x,y,z,radius].'),
            enabled: z.boolean().optional().describe('show/hide the region.'),
            gizmoMode: z.enum(['move', 'resize']).optional().describe('collision_region only.')
        }
    }, editor(async (args) => await callEditor('set_region', args)));

    server.registerTool('render_pose', {
        title: 'Render pose',
        description:
            'Read or set the offline-render (WebP) camera pose shown as a frustum in the viewport. SPLAT frame (viewer [x,y,z] -> [x,-y,-z]) — the same values render_image takes. action="get" -> {camera,lookAt}; "set" takes camera/lookAt as [x,y,z].',
        annotations: SAFE,
        inputSchema: {
            action: z.enum(['get', 'set']),
            camera: vec3.optional(),
            lookAt: vec3.optional()
        }
    }, editor(async (args) => await callEditor('render_pose', args)));

    server.registerTool('set_collision_gizmo', {
        title: 'Set collision gizmo',
        description:
            'Set a collision input gizmo. target="seed" sets the --seed-pos point [x,y,z] in VOXEL space (viewer [x,y,z] -> [-x,y,-z]; Y-up, 1m above floor = [0,1,0]); target="capsule" sets the player capsule {height,radius}.',
        annotations: SAFE,
        inputSchema: {
            target: z.enum(['seed', 'capsule']),
            seed: vec3.optional().describe('seed position [x,y,z] (CLI space).'),
            height: z.number().positive().optional().describe('capsule height (target="capsule").'),
            radius: z.number().positive().optional().describe('capsule radius (target="capsule").')
        }
    }, editor(async (args) => await callEditor('set_collision_gizmo', args)));

    // ---- history ----
    server.registerTool('history', {
        title: 'Undo / redo',
        description:
            'Editor undo/redo over form fields, the loaded splat, and layer visibility (snapshot-based, in-memory). action="get" -> {canUndo,canRedo}; "undo"/"redo" step the history. Job runs and file deletes are NOT undoable.',
        annotations: SAFE,
        inputSchema: { action: z.enum(['get', 'undo', 'redo']) }
    }, editor(async (args) => await callEditor('history', args)));

    // ---- dock ----
    server.registerTool('panel', {
        title: 'Panel',
        description: 'Open or close a dock panel by id: panel-files, panel-convert, panel-lod, panel-render, panel-analyze, panel-edit, panel-collision, panel-scene, panel-settings (the MCP consent toggle lives there), panel-job.',
        annotations: SAFE,
        inputSchema: {
            action: z.enum(['open', 'close']),
            id: z.string().describe('dock panel id.')
        }
    }, editor(async (args) => await callEditor('panel', args)));

    server.registerTool('layout', {
        title: 'Layout',
        description: 'Dock layout. action="get" returns the current dockview layout; "set" applies a layout object; "reset" restores the default layout.',
        annotations: SAFE,
        inputSchema: {
            action: z.enum(['get', 'set', 'reset']),
            layout: z.record(z.string(), z.any()).optional().describe('dockview layout object (action="set").')
        }
    }, editor(async (args) => await callEditor('layout', args)));
}
