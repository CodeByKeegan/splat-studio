import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { checkForUpdates } from './updates.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In dev this is the repo root; when packaged it's resources/app — either way
// server/, dist/ and node_modules/ sit directly under it, so the server's own
// relative paths (CLI lookup, dist serving) resolve unchanged.
const appRoot = path.resolve(__dirname, '..');

// Only one instance: the embedded server binds a port and owns the workspace.
if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}

// ---------- persisted config (workspace folder) ----------
const configFile = () => path.join(app.getPath('userData'), 'config.json');

const readConfig = () => {
    try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
};

const writeConfig = (cfg) => {
    try {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
    } catch (err) {
        console.error('failed to persist config:', err.message);
    }
};

const defaultWorkspace = () => path.join(app.getPath('documents'), 'Splat Studio');

// precedence: a previously-chosen folder (config) → SPLAT_WORKSPACE env → default
let workspace = readConfig().workspace || process.env.SPLAT_WORKSPACE || defaultWorkspace();

// The server (and the splat-transform CLI it spawns) must run under a real Node
// binary, not the Electron binary: the CLI's native WebGPU/Dawn device segfaults
// (access violation) when hosted inside Electron, even via ELECTRON_RUN_AS_NODE.
// Packaged builds bundle node.exe under resources/; dev (`electron .`) falls back
// to a `node` on PATH.
const nodeBin = () => (app.isPackaged
    ? path.join(process.resourcesPath, process.platform === 'win32' ? 'node.exe' : 'node')
    : (process.env.SPLAT_NODE_BIN || 'node'));

// ---------- embedded server ----------
let serverProc = null;
let serverPort = 0;
let win = null;
let quitting = false;

const freePort = () => new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
    });
});

const waitForHealth = (port, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
            res.resume();
            if (res.statusCode === 200) resolve();
            else retry();
        });
        req.on('error', retry);
        req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
        if (Date.now() > deadline) reject(new Error('embedded server did not become ready'));
        else setTimeout(attempt, 250);
    };
    attempt();
});

const startServer = async () => {
    serverPort = await freePort();
    fs.mkdirSync(workspace, { recursive: true });
    const entry = path.join(appRoot, 'server', 'index.mjs');
    const env = { ...process.env, API_PORT: String(serverPort), SPLAT_WORKSPACE: workspace };
    // strip any inherited ELECTRON_RUN_AS_NODE so the child node.exe behaves normally
    delete env.ELECTRON_RUN_AS_NODE;
    serverProc = spawn(nodeBin(), [entry], {
        cwd: appRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
    });
    serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    serverProc.on('exit', (code) => {
        const wasRunning = serverProc !== null;
        serverProc = null;
        if (!quitting && wasRunning && code) {
            dialog.showErrorBox('Splat Studio', `The background engine exited unexpectedly (code ${code}).`);
        }
    });
    await waitForHealth(serverPort);
};

const stopServer = () => new Promise((resolve) => {
    const proc = serverProc;
    serverProc = null;
    if (!proc || proc.exitCode !== null) return resolve();
    proc.once('exit', () => resolve());
    proc.kill();
    setTimeout(resolve, 3000); // don't hang shutdown if it ignores the signal
});

// ---------- window ----------
const appUrl = () => `http://127.0.0.1:${serverPort}/`;

const createWindow = () => {
    win = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 940,
        minHeight: 600,
        backgroundColor: '#15151a',
        title: 'Splat Studio',
        icon: process.platform === 'win32' ? path.join(appRoot, 'build', 'icon.ico') : undefined,
        show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    win.once('ready-to-show', () => {
        win.show();
        // a few seconds after the UI is up, quietly check for a newer release
        setTimeout(() => checkForUpdates(win, { silent: true }), 4000);
    });
    win.loadURL(appUrl());
    win.on('closed', () => { win = null; });
};

// ---------- workspace switching ----------
const setWorkspace = async (next) => {
    workspace = next;
    writeConfig({ ...readConfig(), workspace });
    await stopServer();
    await startServer();
    if (win) win.loadURL(appUrl());
};

const chooseWorkspace = async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Choose workspace folder',
        defaultPath: workspace,
        properties: ['openDirectory', 'createDirectory'],
        message: 'Each subfolder of this folder is a project.'
    });
    if (!canceled && filePaths[0]) await setWorkspace(filePaths[0]);
};

// ---------- menu ----------
const buildMenu = () => {
    const template = [
        {
            label: 'File',
            submenu: [
                { label: 'Change Workspace Folder…', accelerator: 'CmdOrCtrl+O', click: chooseWorkspace },
                { label: 'Open Workspace in Explorer', click: () => shell.openPath(workspace) },
                { type: 'separator' },
                { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
                { label: 'Toggle Developer Tools', accelerator: 'F12', click: () => win?.webContents.toggleDevTools() }
            ]
        },
        {
            label: 'Help',
            submenu: [
                { label: 'Check for Updates…', click: () => checkForUpdates(win, { silent: false }) },
                { label: 'Project on GitHub', click: () => shell.openExternal('https://github.com/CodeByKeegan/splat-studio') },
                {
                    label: 'About Splat Studio',
                    click: () => dialog.showMessageBox(win, {
                        type: 'info',
                        title: 'About Splat Studio',
                        message: `Splat Studio ${app.getVersion()}`,
                        detail: `A GUI for @playcanvas/splat-transform.\n\nWorkspace: ${workspace}\nEngine: Electron ${process.versions.electron}`
                    })
                }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

// ---------- lifecycle ----------
app.whenReady().then(async () => {
    buildMenu();
    try {
        await startServer();
    } catch (err) {
        dialog.showErrorBox('Splat Studio', `Failed to start the background engine:\n\n${err.message}`);
        app.quit();
        return;
    }
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('second-instance', () => {
    if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', (e) => {
    if (!serverProc) return;
    e.preventDefault();
    stopServer().then(() => app.exit(0));
});
