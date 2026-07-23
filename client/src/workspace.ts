// Workspace folder switching: the Settings picker, persisting through the
// desktop bridge, and reflecting switches initiated elsewhere (MCP).
import * as api from './api';
import { $ } from './dom';
import { hooks } from './state';
import { showToast, promptText } from './ui';
import { loadProjects } from './projects';
import type { DesktopApi } from './desktop-types';

// The native folder picker lives in Electron (preload -> main); the actual switch
// goes through POST /api/workspace so it works headlessly (MCP) and in the browser.
const desktop = (window as unknown as { desktop?: DesktopApi }).desktop;
let currentWorkspace = '';
let wsSwitching = false;
const wsPathEl = $<HTMLInputElement>('ws-path');

const showWorkspace = (p: string): void => {
    currentWorkspace = p;
    wsPathEl.value = p;
    wsPathEl.title = p;
};

const applyWorkspace = async (target: string): Promise<void> => {
    wsSwitching = true;
    try {
        const ws = await api.setWorkspace(target);
        await desktop?.persistWorkspace(ws.path);
        showWorkspace(ws.path);
        await loadProjects();
        void hooks.syncEditorStatus(); // consent reset on switch — reflect it (main assigns the hook at boot)
        showToast(`Workspace set to ${ws.path}`);
    } finally {
        wsSwitching = false;
    }
};

const chooseWorkspaceFolder = async (): Promise<void> => {
    const target = desktop?.pickFolder
        ? await desktop.pickFolder(currentWorkspace)
        : await promptText('Workspace folder (absolute path)', { value: currentWorkspace, okLabel: 'Set' });
    if (!target) return;
    try { await applyWorkspace(target); }
    catch (err) { showToast(`Couldn't set workspace: ${err}`, true); }
};

// a workspace switch initiated elsewhere (an MCP agent) — reflect it live
export const onWorkspaceSwitched = async (): Promise<void> => {
    if (wsSwitching) return; // our own switch already handles the UI
    try {
        const ws = await api.getWorkspace();
        if (ws.path === currentWorkspace) return;
        await desktop?.persistWorkspace(ws.path);
        showWorkspace(ws.path);
        await loadProjects();
        void hooks.syncEditorStatus(); // consent reset on switch — reflect it (main assigns the hook at boot)
        showToast(`Workspace set to ${ws.path}`);
    } catch { /* server momentarily unavailable */ }
};

$<HTMLButtonElement>('ws-change').onclick = () => void chooseWorkspaceFolder();
const wsOpenBtn = $<HTMLButtonElement>('ws-open');
if (desktop?.openWorkspace) { wsOpenBtn.hidden = false; wsOpenBtn.onclick = () => void desktop.openWorkspace(); }
desktop?.onChooseWorkspace(() => void chooseWorkspaceFolder());
void api.getWorkspace().then((ws) => showWorkspace(ws.path)).catch(() => { /* server not up yet */ });
