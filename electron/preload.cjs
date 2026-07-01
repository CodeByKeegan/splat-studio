// Minimal, safe bridge for renderer -> main (contextIsolation on). Only the
// native folder picker and workspace persistence are exposed; the actual
// workspace switch goes through the loopback API like everything else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
    // native "choose folder" dialog; resolves the picked path or null if cancelled
    pickFolder: (defaultPath) => ipcRenderer.invoke('workspace:pick', defaultPath),
    // persist the chosen workspace so the next launch starts there
    persistWorkspace: (path) => ipcRenderer.invoke('workspace:persist', path),
    // reveal the current workspace folder in the OS file browser
    openWorkspace: () => ipcRenderer.invoke('workspace:open'),
    // File > Change Workspace Folder… routes here so the renderer runs one flow
    onChooseWorkspace: (cb) => ipcRenderer.on('menu:choose-workspace', () => cb())
});
