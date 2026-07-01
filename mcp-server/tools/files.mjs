// Headless FILES tools (not consent-gated): projects, files, import_file.
import { z } from 'zod';
import path from 'node:path';
import { apiGet, apiPost, apiDelete, apiUploadFile, qs } from '../http.mjs';
import { headless } from './_wrap.mjs';

const SEG = 'letters, digits, spaces, and ( ) . _ -';

export function register(server) {
    server.registerTool('projects', {
        title: 'Projects',
        description:
            'List the workspace projects, or create a new empty project. Each top-level workspace subfolder is a project; output bundles are excluded. action="list" returns {projects:[name,...]}.',
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
            'List the primary assets in a project (each with kind + viewable tag; output bundles collapse to their entry point), or delete a file. Deleting a meta.json / lod-meta.json bundle entry point removes the whole folder.',
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
            'Upload a local splat/source file into a project (streamed; 8 GB cap). The destination is a single-segment file at the project root.',
        inputSchema: {
            project: z.string().describe('Destination project name.'),
            source_path: z.string().describe('Absolute path to the local file to upload.'),
            name: z.string().optional().describe('Destination file name (single segment). Defaults to the source file name.')
        }
    }, headless(async ({ project, source_path, name }) => {
        const dest = name || path.basename(source_path);
        return await apiUploadFile(`/api/upload${qs({ project, name: dest })}`, source_path);
    }));
}
