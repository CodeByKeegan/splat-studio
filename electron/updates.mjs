// In-app auto-update via electron-updater with two channels: STABLE (latest.yml,
// from main) and BETA (beta.yml, from dev prereleases). The user's channel choice
// is persisted in userData/config.json and applied at runtime via autoUpdater.channel
// before each check, so the feed the app follows never depends on the installed
// build's version string. Beta builds are published with
// generateUpdatesFilesForAllChannels:true, so a beta release also ships latest.yml —
// electron-updater's rule (beta users get beta AND latest) then serves both from one
// GitHub feed. NSIS only; the app is unsigned so downloads are verified by SHA-512.
import { app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

const OWNER = 'CodeByKeegan';
const REPO = 'splat-studio';
export const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases`;

export const CHANNELS = ['stable', 'beta'];
const DEFAULT_CHANNEL = 'stable';

let getWin = () => null;
let manualCheck = false;      // current check is user-initiated -> show up-to-date/errors
let lastPromptedVersion = null;
let lastInstalledPromptFor = null;
let wired = false;
let checking = false;

// ---- channel persistence (shares userData/config.json with main.mjs) ----
const configFile = () => path.join(app.getPath('userData'), 'config.json');
const readCfg = () => { try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; } };
const writeCfg = (cfg) => {
    try {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
    } catch (err) { console.error('[update] persist channel failed:', err.message); }
};

export function getChannel() {
    const c = readCfg().updateChannel;
    return CHANNELS.includes(c) ? c : DEFAULT_CHANNEL;
}

// electron-updater's channel setter uses the file name: 'latest' -> latest.yml,
// anything else -> <name>.yml. Map our 'stable' onto 'latest'.
const feedChannel = (c) => (c === 'beta' ? 'beta' : 'latest');

const applyChannel = (c) => {
    // setting .channel also flips allowDowngrade=true, which is what we want when a
    // beta user (version x.y.z-beta.N) switches to stable (numerically "older").
    autoUpdater.channel = feedChannel(c);
    // beta only: with allowPrerelease + an explicit channel, the GitHub provider only
    // accepts feed tags whose prerelease id is alpha/beta or equals the channel — with
    // channel 'latest' nothing ever matches ("No published versions on GitHub").
    // Stable instead resolves releases/latest (which skips prereleases).
    autoUpdater.allowPrerelease = c === 'beta';
};

const clearBar = () => { const w = getWin(); if (w && !w.isDestroyed()) w.setProgressBar(-1); };

const wire = () => {
    if (wired) return;
    wired = true;

    // Low friction: download in the background, prompt only once at install time,
    // and install on quit if the user never clicks Restart.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
        info: (...a) => console.log('[update]', ...a),
        warn: (...a) => console.warn('[update]', ...a),
        error: (...a) => console.error('[update]', ...a),
        debug: () => {}
    };

    autoUpdater.on('update-available', (info) => {
        const v = info?.version;
        // With autoDownload on we don't prompt here; the download starts automatically
        // and we prompt once it's ready. Only surface a note for a truly manual check.
        if (manualCheck) {
            const w = getWin();
            if (w && !w.isDestroyed()) w.setProgressBar(0); // show activity immediately
        }
        lastPromptedVersion = v;
    });

    autoUpdater.on('update-not-available', () => {
        if (manualCheck) {
            dialog.showMessageBox(getWin() ?? undefined, {
                type: 'info', title: 'Up to date',
                message: `Splat Studio ${app.getVersion()} is the latest ${getChannel()} version.`
            });
        }
        manualCheck = false;
    });

    autoUpdater.on('download-progress', (p) => {
        const w = getWin();
        if (w && !w.isDestroyed()) w.setProgressBar(Math.max(0, Math.min(1, (p?.percent ?? 0) / 100)));
    });

    autoUpdater.on('update-downloaded', async (info) => {
        clearBar();
        const v = info?.version;
        // one prompt, only when the bits are ready (skip re-nagging the same version on periodic ticks)
        if (!manualCheck && v && v === lastInstalledPromptFor) return;
        lastInstalledPromptFor = v;
        manualCheck = false;
        const { response } = await dialog.showMessageBox(getWin() ?? undefined, {
            type: 'info', title: 'Update ready',
            message: `Splat Studio ${v} is ready to install.`,
            detail: 'Restart now to update? It will also install automatically next time you quit.',
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
        void runCheck({ silent: true });
    }, 3 * 60 * 60 * 1000);
};

async function runCheck({ silent }) {
    manualCheck = !silent;
    applyChannel(getChannel());
    checking = true;
    try { await autoUpdater.checkForUpdates(); }
    catch { /* 'error' event handles it */ }
    finally { checking = false; }
}

/**
 * @param {Electron.BrowserWindow|null} win
 * @param {{silent?: boolean}} [opts] silent (startup/periodic) suppresses the
 *   up-to-date / error dialogs; an explicit check shows them.
 */
export async function checkForUpdates(win, { silent = true } = {}) {
    if (win) getWin = () => win;
    // dev builds have no app-update.yml; only the installed app can self-update
    if (!app.isPackaged && !process.env.SPLAT_FORCE_UPDATE_CHECK) {
        if (!silent) dialog.showMessageBox(win ?? undefined, { type: 'info', message: 'Update checks run in the installed app.' });
        return;
    }
    wire();
    await runCheck({ silent });
}

/**
 * Switch channel from the UI. Persists the choice and immediately re-checks so the
 * user sees the effect (switching to beta offers the newest beta right away; switching
 * back to stable offers the current stable via allowDowngrade).
 * @param {'stable'|'beta'} channel
 * @param {Electron.BrowserWindow|null} win
 */
export async function setChannel(channel, win) {
    if (!CHANNELS.includes(channel)) return getChannel();
    writeCfg({ ...readCfg(), updateChannel: channel });
    if (app.isPackaged || process.env.SPLAT_FORCE_UPDATE_CHECK) {
        if (win) getWin = () => win;
        wire();
        await runCheck({ silent: false }); // manual so the user gets feedback
    }
    return channel;
}
