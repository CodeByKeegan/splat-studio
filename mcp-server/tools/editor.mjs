// EDITOR tools (consent-gated). Each forwards a command to the running GUI via
// POST /api/editor/command (the relay correlates + the client bridge dispatches
// through the real main.ts actions, so gizmos + form fields + persistence all
// update together). All are gated by the MCP consent toggle (control-disabled
// when off) and return no-editor when the app isn't connected.
import { z } from 'zod';
import { apiPost } from '../http.mjs';
import { okResult, failResult, imageResult, mapEditorError } from '../errors.mjs';

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
            'Read or drive the live viewport camera (VIEWER-WORLD frame). action="get" -> {eye,target,...}; "set" needs eye+target; "frame" frames the scene; "mode" switches fly/orbit + perspective/ortho.',
        inputSchema: {
            action: z.enum(['get', 'set', 'mode', 'frame']),
            eye: vec3.optional().describe('camera position [x,y,z] (set).'),
            target: vec3.optional().describe('look-at point [x,y,z] (set).'),
            mode: z.enum(['fly', 'orbit', 'perspective', 'ortho']).optional().describe('camera mode (action="mode").')
        }
    }, editor(async (args) => await callEditor('camera', args)));

    server.registerTool('viewport_screenshot', {
        title: 'Viewport screenshot',
        description: 'Capture a full-resolution PNG of the main viewport camera and return it as an image.',
        inputSchema: {}
    }, async () => {
        try {
            const data = await callEditor('viewport_screenshot', {});
            return imageResult(data.png, { width: data.width, height: data.height });
        } catch (e) {
            return failResult(e && e.error ? e : { error: 'bad-input', message: e?.message || String(e) });
        }
    });

    server.registerTool('viewport_click', {
        title: 'Viewport click',
        description:
            'Pick the front splat surface at normalized viewport coords (x,y in 0..1) and place the active marker there. Returns the picked point in VIEWER-WORLD space, or {hit:false}.',
        inputSchema: {
            x: z.number().min(0).max(1).describe('horizontal fraction (0=left, 1=right).'),
            y: z.number().min(0).max(1).describe('vertical fraction (0=top, 1=bottom).')
        }
    }, editor(async (args) => await callEditor('viewport_click', args)));

    server.registerTool('load_into_viewport', {
        title: 'Load into viewport',
        description: 'action="load" loads a project file (a viewable splat/collision) into the 3D viewport; "clear" empties it.',
        inputSchema: {
            action: z.enum(['load', 'clear']),
            project: z.string().optional().describe('project name (required for load).'),
            file: z.string().optional().describe('project-relative file (required for load).')
        }
    }, editor(async (args) => await callEditor('load_into_viewport', args)));

    server.registerTool('select_item', {
        title: 'Select item',
        description: 'Select a scene-hierarchy item by id (or pass id:null to clear the selection), raising its gizmo. Use get_editor_state to list selectable items.',
        inputSchema: { id: z.string().nullable().describe('scene item id, or null to deselect.') }
    }, editor(async (args) => await callEditor('select_item', args)));

    server.registerTool('get_editor_state', {
        title: 'Get editor state',
        description:
            'Snapshot the live editor: active panel, current selection, scene items, layer visibility, active tool, loaded splat, and camera. Use this for editor reads instead of separate getters.',
        inputSchema: {}
    }, editor(async () => await callEditor('get_editor_state', {})));

    // ---- scene display ----
    server.registerTool('set_view_option', {
        title: 'Set view option',
        description:
            'Toggle a viewport display option. option="bounds" (value bool); "skybox" (value = a project image file name, or null to clear); "collision_style" (value xray|hidden|solid); "layer" (target splat|collision|voxels, value bool).',
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
            'Measure-to-scale tool. action="measure" reads the current A/B markers + span; action="set_length" sets the real-world A-B length (m) so the next Apply scales the splat to match. Place markers with viewport_click while the Edit panel is active.',
        inputSchema: {
            action: z.enum(['measure', 'set_length']),
            length: z.number().positive().optional().describe('real A-B length in meters (action="set_length").')
        }
    }, editor(async (args) => await callEditor('measure', args)));

    server.registerTool('set_origin', {
        title: 'Set origin',
        description: 'Set the edit origin to a point so the splat recenters there on Apply. Provide a viewer-world point, or omit to use the current marker. The CLI translate is derived internally.',
        inputSchema: { point: vec3.optional().describe('viewer-world point to make the new origin.') }
    }, editor(async (args) => await callEditor('set_origin', args)));

    server.registerTool('set_region', {
        title: 'Set region',
        description:
            'Set a viewport region gizmo. target="crop_box"/"crop_sphere" drive the Edit-panel crop/carve region (-B/-S action space); target="collision_region"/"collision_sphere" drive the Collision-panel region filters (R_y(180) CLI space).',
        inputSchema: {
            target: z.enum(['crop_box', 'crop_sphere', 'collision_region', 'collision_sphere']),
            box: boxArr.optional().describe('[minX,minY,minZ,maxX,maxY,maxZ]; "" or "-" = unbounded side.'),
            sphere: sphereArr.optional().describe('[x,y,z,radius].'),
            enabled: z.boolean().optional().describe('show/hide the region.'),
            gizmoMode: z.enum(['move', 'resize']).optional().describe('deprecated — accepted and ignored (move + resize handles are always active).')
        }
    }, editor(async (args) => await callEditor('set_region', args)));

    server.registerTool('render_pose', {
        title: 'Render pose',
        description:
            'Read or set the offline-render (WebP) camera pose shown as a frustum in the viewport. CLI space. action="get" -> {camera,lookAt}; "set" takes camera/lookAt (and optional up) as [x,y,z].',
        inputSchema: {
            action: z.enum(['get', 'set']),
            camera: vec3.optional(),
            lookAt: vec3.optional(),
            up: vec3.optional()
        }
    }, editor(async (args) => await callEditor('render_pose', args)));

    server.registerTool('set_collision_gizmo', {
        title: 'Set collision gizmo',
        description:
            'Set a collision input gizmo. target="seed" sets the --seed-pos point [x,y,z] in CLI space (engine Y-up; 1m above floor = [0,1,0]); target="capsule" sets the player capsule {height,radius}.',
        inputSchema: {
            target: z.enum(['seed', 'capsule']),
            seed: vec3.optional().describe('seed position [x,y,z] (CLI space).'),
            height: z.number().positive().optional().describe('capsule height (target="capsule").'),
            radius: z.number().positive().optional().describe('capsule radius (target="capsule").')
        }
    }, editor(async (args) => await callEditor('set_collision_gizmo', args)));

    // ---- dock ----
    server.registerTool('panel', {
        title: 'Panel',
        description: 'Open or close a dock panel by id (e.g. panel-files, panel-convert, panel-lod, panel-render, panel-edit, panel-collision, panel-scene, panel-settings, panel-mcp).',
        inputSchema: {
            action: z.enum(['open', 'close']),
            id: z.string().describe('dock panel id.')
        }
    }, editor(async (args) => await callEditor('panel', args)));

    server.registerTool('layout', {
        title: 'Layout',
        description: 'Dock layout. action="get" returns the current dockview layout; "set" applies a layout object; "reset" restores the default layout.',
        inputSchema: {
            action: z.enum(['get', 'set', 'reset']),
            layout: z.record(z.string(), z.any()).optional().describe('dockview layout object (action="set").')
        }
    }, editor(async (args) => await callEditor('layout', args)));
}
