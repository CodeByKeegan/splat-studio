// Minimal, safe bridge for renderer -> main (contextIsolation on). Only the native
// folder picker, workspace persistence, and update-channel controls are exposed; the
// actual workspace switch goes through the loopback API like everything else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
    // native "choose folder" dialog; resolves the picked path or null if cancelled
    pickFolder: (defaultPath) => ipcRenderer.invoke('workspace:pick', defaultPath),
    // persist the chosen workspace so the next launch starts there
    persistWorkspace: (path) => ipcRenderer.invoke('workspace:persist', path),
    // reveal the current workspace folder in the OS file browser
    openWorkspace: () => ipcRenderer.invoke('workspace:open'),
    // File > Change Workspace Folder… routes here so the renderer runs one flow
    onChooseWorkspace: (cb) => ipcRenderer.on('menu:choose-workspace', () => cb()),

    // ----- updates -----
    // user-initiated update check (shows up-to-date / error dialogs)
    checkForUpdates: () => ipcRenderer.invoke('updates:check'),
    // current channel: 'stable' | 'beta'
    getUpdateChannel: () => ipcRenderer.invoke('updates:get-channel'),
    // switch channel; persists and re-checks. Resolves to the applied channel.
    setUpdateChannel: (channel) => ipcRenderer.invoke('updates:set-channel', channel),
    // live updater state for the settings status line: {phase, version?, percent?, ...}
    getUpdateStatus: () => ipcRenderer.invoke('updates:get-status'),
    onUpdateStatus: (cb) => ipcRenderer.on('updates:status', (_e, status) => cb(status)),
    // start downloading the update found by the last check
    downloadUpdate: () => ipcRenderer.invoke('updates:download'),
    // auto-download toggle: true = downloads start without the Download button
    getUpdateAuto: () => ipcRenderer.invoke('updates:get-auto'),
    setUpdateAuto: (on) => ipcRenderer.invoke('updates:set-auto', on)
});
