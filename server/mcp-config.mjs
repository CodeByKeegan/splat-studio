// MCP editor-control consent: server-owned, persisted per workspace, fail-closed.
// Stored as a workspace-root dotfile (.splat-studio-mcp.json), sibling to the
// layout dotfile. Default OFF; a read failure reads as OFF.
import fs from 'node:fs/promises';
import path from 'node:path';

const configFile = (workspaceDir) => path.join(workspaceDir, '.splat-studio-mcp.json');

export const readMcpConfig = async (workspaceDir) => {
    try {
        const c = JSON.parse(await fs.readFile(configFile(workspaceDir), 'utf8'));
        return { controlEnabled: c?.controlEnabled === true };
    } catch {
        return { controlEnabled: false }; // fail-closed: missing/corrupt => off
    }
};

export const isControlEnabled = async (workspaceDir) => (await readMcpConfig(workspaceDir)).controlEnabled;

export const setControlEnabled = async (workspaceDir, enabled) => {
    const data = { controlEnabled: !!enabled };
    const file = configFile(workspaceDir);
    const tmp = `${file}.${Date.now().toString(36)}.tmp`;
    try {
        await fs.writeFile(tmp, JSON.stringify(data, null, 2)); // tmp + rename = atomic
        await fs.rename(tmp, file);
    } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
    }
    return data;
};
