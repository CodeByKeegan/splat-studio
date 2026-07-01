// In-app auto-update via electron-updater. Checks the GitHub release feed, downloads
// the new NSIS installer in the background (with taskbar progress), and applies it on
// restart. The build's `publish: github` config makes electron-builder emit the
// latest.yml + app-update.yml this relies on. NSIS target only — the portable exe
// can't self-update. The app is unsigned, so electron-updater verifies the download
// by SHA-512 (from latest.yml), not by code signature.
import { app, dialog } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

const OWNER = 'CodeByKeegan';
const REPO = 'splat-studio';
export const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;

let getWin = () => null;
let manualCheck = false; // the current check was user-initiated → show up-to-date / errors
let lastPromptedVersion = null; // don't re-nag for the same version on periodic checks
let wired = false;
let checking = false; // a check is in flight — periodic ticks skip so they don't clobber manualCheck

const clearBar = () => { const w = getWin(); if (w && !w.isDestroyed()) w.setProgressBar(-1); };

const wire = () => {
    if (wired) return;
    wired = true;

    autoUpdater.autoDownload = false; // prompt before downloading
    autoUpdater.autoInstallOnAppQuit = true; // if downloaded but not restarted, install on next quit
    autoUpdater.logger = {
        info: (...a) => console.log('[update]', ...a),
        warn: (...a) => console.warn('[update]', ...a),
        error: (...a) => console.error('[update]', ...a),
        debug: () => {}
    };

    autoUpdater.on('update-available', async (info) => {
        const v = info?.version;
        if (!manualCheck && v && v === lastPromptedVersion) return; // already offered this one
        lastPromptedVersion = v;
        manualCheck = false;
        const { response } = await dialog.showMessageBox(getWin() ?? undefined, {
            type: 'info', title: 'Update available',
            message: `Splat Studio ${v} is available.`,
            detail: `You're on ${app.getVersion()}. Download it now? It installs in the background and asks you to restart when it's ready.`,
            buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1
        });
        if (response === 0) {
            try { await autoUpdater.downloadUpdate(); } catch { /* 'error' event handles it */ }
        }
    });

    autoUpdater.on('update-not-available', () => {
        if (manualCheck) {
            dialog.showMessageBox(getWin() ?? undefined, { type: 'info', title: 'Up to date', message: `Splat Studio ${app.getVersion()} is the latest version.` });
        }
        manualCheck = false;
    });

    autoUpdater.on('download-progress', (p) => {
        const w = getWin();
        if (w && !w.isDestroyed()) w.setProgressBar(Math.max(0, Math.min(1, (p?.percent ?? 0) / 100)));
    });

    autoUpdater.on('update-downloaded', async (info) => {
        clearBar();
        const { response } = await dialog.showMessageBox(getWin() ?? undefined, {
            type: 'info', title: 'Update ready',
            message: `Splat Studio ${info?.version} has been downloaded.`,
            detail: 'Restart now to install it? (It will also install automatically next time you quit.)',
            buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1
        });
        if (response === 0) setImmediate(() => autoUpdater.quitAndInstall());
    });

    autoUpdater.on('error', (err) => {
        clearBar();
        if (manualCheck) dialog.showErrorBox('Update check failed', String(err?.message || err));
        manualCheck = false;
        console.error('[update] error:', err?.message || err);
    });

    // periodic silent re-check so a long-running session still notices new releases
    setInterval(() => {
        if (!app.isPackaged || checking) return;
        manualCheck = false;
        checking = true;
        autoUpdater.checkForUpdates().catch(() => {}).finally(() => { checking = false; });
    }, 3 * 60 * 60 * 1000);
};

/**
 * @param {Electron.BrowserWindow|null} win
 * @param {{silent?: boolean}} [opts] silent (startup/periodic) suppresses the
 *   up-to-date / error dialogs; an explicit menu check shows them.
 */
export async function checkForUpdates(win, { silent = true } = {}) {
    if (win) getWin = () => win;
    manualCheck = !silent;
    // dev builds have no app-update.yml; only the installed app can self-update
    if (!app.isPackaged && !process.env.SPLAT_FORCE_UPDATE_CHECK) {
        if (!silent) dialog.showMessageBox(win ?? undefined, { type: 'info', message: 'Update checks run in the installed app.' });
        return;
    }
    wire();
    checking = true;
    try { await autoUpdater.checkForUpdates(); }
    catch { /* 'error' event handles it */ }
    finally { checking = false; }
}
