// Headless FILES tools (not consent-gated): workspace, projects, files, import_file.
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { apiGet, apiPost, apiDelete, apiUploadFile, qs } from '../http.mjs';
import { headless, RO, SAFE, DEL } from './_wrap.mjs';

const SEG = 'letters, digits, spaces, and ( ) . _ -';

export function register(server) {
    server.registerTool('workspace', {
        title: 'Workspace',
        description:
            'Get or change the workspace folder — the parent folder whose subfolders are projects. action="get" returns {path, projects:[...]}. action="set" re-points the whole app at `path` (live, no restart) and returns the new {path, projects}; the folder must already exist unless create=true. NOTE: switching workspace resets the editor-control consent to OFF (the user must re-enable it).',
        annotations: SAFE,
        inputSchema: {
            action: z.enum(['get', 'set']).describe('get = current workspace path + projects; set = switch to a different folder'),
            path: z.string().optional().describe('Absolute folder path to switch to (required when action="set").'),
            create: z.boolean().optional().describe('When action="set" and the folder does not exist, create it (default false).')
        }
    }, headless(async ({ action, path: p, create }) => {
        if (action === 'set') {
            if (!p) throw new Error('path is required when action="set"');
            return await apiPost('/api/workspace', { path: p, create: !!create });
        }
        return await apiGet('/api/workspace');
    }));

    server.registerTool('projects', {
        title: 'Projects',
        description:
            'List the workspace projects, or create a new empty project. Each top-level workspace subfolder is a project; output bundles are excluded. action="list" returns {projects:[name,...]}.',
        annotations: SAFE,
        inputSchema: {
            action: z.enum(['list', 'create']).describe('list = enumerate projects; create = make a new empty project folder'),
            name: z.string().optional().describe(`Project name to create (required when action="create"). Allowed: ${SEG}.`)
        }
    }, headless(async ({ action, name }) => {
        if (action === 'create') {
            if (!name) throw new Error('name is required when action="create"');
            return await apiPost('/api/projects', { name });
        }
        return await apiGet('/api/projects');
    }));

    server.registerTool('files', {
        title: 'Files',
        description:
            'List the primary assets in a project (each with kind + viewable tag; output bundles collapse to their entry point), or delete a file. Deleting a meta.json / lod-meta.json bundle entry point removes the whole folder. Deletes are NOT undoable.',
        annotations: DEL,
        inputSchema: {
            action: z.enum(['list', 'delete']).describe('list = enumerate files; delete = remove a file (or its bundle folder)'),
            project: z.string().describe('Project name the files live in.'),
            name: z.string().optional().describe('Project-relative file path to delete (required when action="delete"; up to 4 path segments).')
        }
    }, headless(async ({ action, project, name }) => {
        if (action === 'delete') {
            if (!name) throw new Error('name is required when action="delete"');
            const rel = String(name).split('/').map(encodeURIComponent).join('/');
            return await apiDelete(`/api/files/${rel}${qs({ project })}`);
        }
        return await apiGet(`/api/files${qs({ project })}`);
    }));

    server.registerTool('import_file', {
        title: 'Import file',
        description:
            'Upload a local splat/source file into a project (streamed; 8 GB cap). The destination is a single-segment file at the project root; an existing file with the same name is OVERWRITTEN.',
        annotations: DEL,
        inputSchema: {
            project: z.string().describe('Destination project name.'),
            source_path: z.string().describe('Absolute path to the local file to upload.'),
            name: z.string().optional().describe('Destination file name (single segment). Defaults to the source file name.')
        }
    }, headless(async ({ project, source_path, name }) => {
        if (!fs.existsSync(source_path)) throw new Error(`source_path not found: ${source_path}`);
        const dest = name || path.basename(source_path);
        return await apiUploadFile(`/api/upload${qs({ project, name: dest })}`, source_path);
    }));
}
