// Settings dialog (nav + pages), the Updates page + bottom-right status
// widget, the About component versions, and the decimation scratch-dir picker.
import * as api from './api';
import { $ } from './dom';
import { promptText } from './ui';
import { initThemeSettings } from './theme';
import { SplatViewer } from './viewer';
import { desktop, type UpdateStatus } from './desktop-types';

const settingsBackdrop = $<HTMLDivElement>('settings-backdrop');
export function isSettingsOpen(): boolean { return !settingsBackdrop.classList.contains('hidden'); }
function showSettingsPage(page: string): void {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#settings-nav .settings-nav-item')) {
        b.classList.toggle('active', b.dataset.page === page);
    }
    for (const p of document.querySelectorAll<HTMLElement>('.settings-page')) {
        p.classList.toggle('hidden', p.dataset.page !== page);
    }
}
export function openSettings(page?: string): void {
    settingsBackdrop.classList.remove('hidden');
    if (page) showSettingsPage(page);
}
export function closeSettings(): void { settingsBackdrop.classList.add('hidden'); }
for (const b of document.querySelectorAll<HTMLButtonElement>('#settings-nav .settings-nav-item')) {
    b.onclick = () => showSettingsPage(b.dataset.page ?? 'appearance');
}
$<HTMLButtonElement>('settings-close').onclick = closeSettings;
settingsBackdrop.addEventListener('pointerdown', (e) => { if (e.target === settingsBackdrop) closeSettings(); });
// promptText's capture-phase Escape handler wins while a prompt is up
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isSettingsOpen()) closeSettings(); });
initThemeSettings();
(window as unknown as { __settings: { open: (page?: string) => void; close: () => void } }).__settings = { open: openSettings, close: closeSettings }; // capture harness handle (scripts/capture-docs.mjs)

// the viewport toolbar's ⚙ opens the settings dialog
$<HTMLButtonElement>('open-settings').onclick = () => openSettings();

// Settings ▸ About: component versions (PlayCanvas from the bundled engine, app + splat-transform from the server)
void (async () => {
    const set = (id: string, v: string | null | undefined) => { const el = $(id); el.textContent = v ? `v${v}` : 'unknown'; };
    set('ver-playcanvas', SplatViewer.engineVersion);
    try { const v = await api.getVersions(); set('ver-app', v.app); set('ver-splat-transform', v.splatTransform); }
    catch { set('ver-app', null); set('ver-splat-transform', null); }
})();

// ----- Settings > Updates + bottom-right status widget -----
// Only meaningful in the packaged desktop app; drop both in the browser dev build.
void (async () => {
    const bridge = desktop;
    const navItem = document.querySelector<HTMLButtonElement>('#settings-nav .settings-nav-item[data-page="updates"]');
    const page = document.querySelector<HTMLElement>('.settings-page[data-page="updates"]');
    const widget = $<HTMLDivElement>('update-widget');
    if (!bridge?.getUpdateChannel) { navItem?.remove(); page?.remove(); widget.remove(); return; }

    const channelSel = $<HTMLSelectElement>('update-channel');
    const checkBtn = $<HTMLButtonElement>('check-updates');
    const downloadBtn = $<HTMLButtonElement>('download-update');
    const autoChk = $<HTMLInputElement>('update-auto');
    const statusEl = $<HTMLSpanElement>('update-status');
    const statusText = $<HTMLSpanElement>('update-status-text');
    const widgetText = $<HTMLSpanElement>('update-widget-text');
    const widgetBar = $<HTMLSpanElement>('update-widget-bar');
    const widgetFill = $<HTMLSpanElement>('update-widget-fill');
    const widgetDownload = $<HTMLButtonElement>('update-widget-download');
    try { channelSel.value = await bridge.getUpdateChannel(); } catch { /* keep default */ }
    try { autoChk.checked = await bridge.getUpdateAuto?.() ?? true; } catch { /* keep default */ }

    // settings status line + bottom-right widget both mirror main-process updater
    // state; checks/downloads keep running with the settings dialog closed
    const showStatus = (s: UpdateStatus): void => {
        const busy = s.phase === 'checking' || s.phase === 'downloading';
        const pct = Math.round(s.percent ?? 0);
        const text =
            s.phase === 'checking' ? 'Checking for updates…' :
            s.phase === 'available' ? `${s.version} available` :
            s.phase === 'downloading' ? `Downloading ${s.version ?? 'update'}… ${pct}%` :
            s.phase === 'ready' ? `${s.version} downloaded — restart to install` :
            s.phase === 'up-to-date' ? `Up to date (${s.version}, ${s.channel})` :
            s.phase === 'error' ? 'Check failed — see error dialog' : '';
        statusEl.classList.toggle('hidden', !text);
        statusEl.classList.toggle('busy', busy);
        statusEl.classList.toggle('error', s.phase === 'error');
        statusText.textContent = text;
        checkBtn.disabled = busy;
        channelSel.disabled = busy;
        downloadBtn.classList.toggle('hidden', s.phase !== 'available');

        const widgetLabel =
            s.phase === 'checking' ? 'Checking for updates…' :
            s.phase === 'available' ? `⬇ ${s.version} available` :
            s.phase === 'downloading' ? `${pct}%` :
            s.phase === 'ready' ? `↻ Restart to update` :
            s.phase === 'up-to-date' ? '✓ Up to date' :
            s.phase === 'error' ? '⚠ Update failed' : '';
        widget.classList.toggle('hidden', !widgetLabel);
        widget.classList.toggle('busy', s.phase === 'checking');
        widget.classList.toggle('error', s.phase === 'error');
        widgetText.textContent = widgetLabel;
        widgetBar.classList.toggle('hidden', s.phase !== 'downloading');
        widgetFill.style.width = `${pct}%`;
        widgetDownload.classList.toggle('hidden', s.phase !== 'available');
    };
    bridge.onUpdateStatus?.(showStatus);
    try { showStatus(await bridge.getUpdateStatus?.() ?? { phase: 'idle' }); } catch { /* keep hidden */ }

    channelSel.addEventListener('change', () => { void bridge.setUpdateChannel?.(channelSel.value as 'stable' | 'beta'); });
    checkBtn.addEventListener('click', () => { void bridge.checkForUpdates?.(); });
    autoChk.addEventListener('change', () => { void bridge.setUpdateAuto?.(autoChk.checked); });
    downloadBtn.addEventListener('click', () => { void bridge.downloadUpdate?.(); });
    widgetDownload.addEventListener('click', () => { void bridge.downloadUpdate?.(); });
    // the widget body always leads to the settings page, whatever the state
    $<HTMLButtonElement>('update-widget-main').addEventListener('click', () => openSettings('updates'));
})();

// ----- Settings > Advanced: decimation scratch dir (--scratch-dir) -----
const scratchDirEl = $<HTMLInputElement>('scratch-dir');
const setScratchDir = (v: string): void => {
    scratchDirEl.value = v;
    scratchDirEl.dispatchEvent(new Event('change', { bubbles: true })); // persist via formState
};
const chooseScratchDirFolder = async (): Promise<void> => {
    const target = desktop?.pickFolder
        ? await desktop.pickFolder(scratchDirEl.value || undefined)
        : await promptText('Scratch directory (absolute path)', { value: scratchDirEl.value, okLabel: 'Set' });
    if (target) setScratchDir(target);
};
$<HTMLButtonElement>('scratch-dir-change').onclick = () => void chooseScratchDirFolder();
$<HTMLButtonElement>('scratch-dir-clear').onclick = () => setScratchDir('');
