// The app menu bar: Edit (undo/redo), Window (panels + Settings), Layout.
import { $ } from './dom';
import { dock, WINDOWS, makeMenu, openWindow, closeWindow, applyDefaultLayout, persistNow } from './dockview';
import { canUndo, canRedo, doUndo, doRedo } from './undo';
import { isSettingsOpen, openSettings, closeSettings } from './settings';

function buildMenuBar(): void {
    const bar = $('menubar');
    bar.innerHTML = '';
    bar.append(
        makeMenu('Edit', () => [
            { label: 'Undo  (Ctrl+Z)', disabled: !canUndo(), onClick: doUndo },
            { label: 'Redo  (Ctrl+Y)', disabled: !canRedo(), onClick: doRedo }
        ]),
        makeMenu('Window', () => [
            ...WINDOWS.map((w) => ({
                label: w.title,
                checked: !!dock.getPanel(w.id),
                onClick: () => { if (dock.getPanel(w.id)) { if (w.closable) closeWindow(w); else openWindow(w); } else openWindow(w); }
            })),
            { label: 'Settings…', checked: isSettingsOpen(), onClick: () => { if (isSettingsOpen()) closeSettings(); else openSettings(); } }
        ]),
        makeMenu('Layout', () => [
            { label: 'Reset to default', onClick: () => { applyDefaultLayout(); persistNow(); } },
            { label: 'Save layout', onClick: persistNow }
        ])
    );
}
buildMenuBar();
