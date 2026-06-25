// Lightweight update check: ask the GitHub Releases API for the latest published
// release and, if it's newer than this build, offer to open the downloads page.
// Deliberately not a full auto-updater — the user chooses to update by visiting
// the releases page, per design.
import { app, dialog, shell } from 'electron';

const OWNER = 'CodeByKeegan';
const REPO = 'splat-studio';
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;

// numeric, dotted compare (tolerates a leading "v"); returns true if a > b
const parseV = (v) => String(v).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
export const isNewer = (a, b) => {
    const x = parseV(a), y = parseV(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d !== 0) return d > 0;
    }
    return false;
};

const fetchLatestTag = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
        const res = await fetch(RELEASES_API, {
            headers: { 'User-Agent': `${REPO}-app`, Accept: 'application/vnd.github+json' },
            signal: ctrl.signal
        });
        if (res.status === 404) return { tag: null, none: true };
        if (!res.ok) throw new Error(`GitHub API ${res.status}`);
        const json = await res.json();
        return { tag: json.tag_name || json.name || null };
    } finally {
        clearTimeout(timer);
    }
};

/**
 * @param {Electron.BrowserWindow|null} win
 * @param {{silent?: boolean}} [opts] silent (startup) suppresses the
 *   "up to date" / "no releases" / error dialogs; an explicit menu check shows them.
 */
export async function checkForUpdates(win, { silent = true } = {}) {
    // dev builds report the package.json version; only nag from packaged builds
    if (!app.isPackaged && !process.env.SPLAT_FORCE_UPDATE_CHECK) {
        if (!silent) dialog.showMessageBox(win ?? undefined, { type: 'info', message: 'Update checks run in the installed app.' });
        return;
    }

    let latest;
    try {
        const { tag, none } = await fetchLatestTag();
        if (none || !tag) {
            if (!silent) dialog.showMessageBox(win ?? undefined, { type: 'info', title: 'No releases yet', message: 'No published releases were found.' });
            return;
        }
        latest = tag;
    } catch (err) {
        if (!silent) dialog.showErrorBox('Update check failed', String(err?.message || err));
        return;
    }

    const current = app.getVersion();
    if (isNewer(latest, current)) {
        const { response } = await dialog.showMessageBox(win ?? undefined, {
            type: 'info',
            title: 'Update available',
            message: `Splat Studio ${latest.replace(/^v/i, '')} is available.`,
            detail: `You're on ${current}. Open the downloads page to get the latest installer?`,
            buttons: ['Go to Downloads', 'Later'],
            defaultId: 0,
            cancelId: 1
        });
        if (response === 0) shell.openExternal(RELEASES_PAGE);
    } else if (!silent) {
        dialog.showMessageBox(win ?? undefined, { type: 'info', title: 'Up to date', message: `Splat Studio ${current} is the latest version.` });
    }
}
