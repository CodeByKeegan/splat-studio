// MCP resources: live read-only listings (projects / jobs / files).
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { apiGet, qs } from '../http.mjs';

export function register(server) {
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
}
