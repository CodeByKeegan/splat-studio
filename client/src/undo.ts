// Global undo/redo: snapshots of the undoable app state (form fields + loaded
// splat + layer visibility), debounced capture, applySnap's synthetic-event
// re-sync, and the Ctrl+Z / Ctrl+Y keybinding.
import { formState, FORM_KEY, EXTERNAL_STATE_IDS } from './form-state';
import { currentSplatName, layerVisible, hooks } from './state';
import type { LayerId } from './state';
import { removeSplat, toggleLayer } from './viewport';
import { viewFile } from './files-panel';

// Snapshot-based over the undoable app state (form fields + loaded splat + layer
// visibility). Each committed change captures a snapshot (debounced so a gizmo drag
// = one step); Ctrl+Z / Ctrl+Y step through them. Job runs and file deletes are NOT
// undoable — they have filesystem side effects.
interface UndoSnap { fields: Record<string, string | boolean>; splat: string | null; layers: Record<string, boolean> }
// snapshot the CURRENT value of every id'd form control (not just changed ones), so
// undoing past a field's first edit still restores its original value
const takeSnap = (): UndoSnap => {
    const fields: Record<string, string | boolean> = {};
    for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[id], select[id]')) {
        if (el.id === 'project-select') continue; // switching projects is navigation, not an edit
        // server/desktop-owned settings (MCP consent, update prefs) are not edits —
        // undoing must never flip consent or the update channel as a side effect
        if (EXTERNAL_STATE_IDS.has(el.id)) continue;
        if (el instanceof HTMLInputElement && (el.type === 'file' || el.type === 'button' || el.type === 'submit')) continue;
        fields[el.id] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
    }
    return { fields, splat: currentSplatName, layers: { ...layerVisible } };
};
export const clearUndoHistory = (): void => { clearTimeout(undoTimer); undoStack.length = 0; redoStack.length = 0; undoCurrent = takeSnap(); };
const snapKey = (s: UndoSnap): string => JSON.stringify(s);
const undoStack: UndoSnap[] = [];
const redoStack: UndoSnap[] = [];
let undoCurrent: UndoSnap; // baseline set by enableUndo() once boot settles
let undoApplying = false;
export const isUndoApplying = (): boolean => undoApplying;
let undoEnabled = false; // suppressed during boot (file-select population shouldn't be undoable)
let undoTimer = 0;
const MAX_UNDO = 100;
export const canUndo = (): boolean => undoStack.length > 0;
export const canRedo = (): boolean => redoStack.length > 0;

const captureUndo = (): void => {
    if (undoApplying) return;
    const next = takeSnap();
    if (snapKey(next) === snapKey(undoCurrent)) return;
    undoStack.push(undoCurrent);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    undoCurrent = next;
};
// called on every committed change; debounced so a burst (e.g. a gizmo drag that
// dispatches change on several fields) collapses into one undo step
const scheduleUndoCapture = (): void => {
    if (undoApplying || !undoEnabled) return;
    clearTimeout(undoTimer);
    undoTimer = window.setTimeout(captureUndo, 250);
};
hooks.scheduleUndoCapture = scheduleUndoCapture; // form-state's change listener calls through the hook
// enable undo capture once after boot settles, discarding any boot-time steps
export const enableUndo = (): void => { undoEnabled = true; clearUndoHistory(); };

const applySnap = async (snap: UndoSnap): Promise<void> => {
    undoApplying = true;
    clearTimeout(undoTimer);
    try {
        for (const [id, value] of Object.entries(snap.fields)) {
            const el = document.getElementById(id);
            if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) continue;
            const isCb = el instanceof HTMLInputElement && el.type === 'checkbox';
            const cur: string | boolean = isCb ? (el as HTMLInputElement).checked : el.value;
            if (cur === value) continue;
            if (isCb) (el as HTMLInputElement).checked = value === true;
            else el.value = String(value);
            formState[id] = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true })); // re-sync gizmos/preview/persistence
        }
        localStorage.setItem(FORM_KEY, JSON.stringify(formState));
        // reload the splat FIRST — viewFile force-shows it, so restore layer visibility after
        if (snap.splat !== currentSplatName) {
            if (snap.splat == null) removeSplat();
            else await viewFile(snap.splat, 'splat');
        }
        for (const id of Object.keys(layerVisible) as LayerId[]) {
            if (layerVisible[id] !== snap.layers[id]) toggleLayer(id);
        }
    } finally {
        undoApplying = false;
        undoCurrent = takeSnap(); // reflect the actual post-apply state (a load may have failed)
    }
};

export const doUndo = (): void => {
    if (undoApplying || !canUndo()) return;
    redoStack.push(undoCurrent);
    undoCurrent = undoStack.pop()!;
    void applySnap(undoCurrent);
};
export const doRedo = (): void => {
    if (undoApplying || !canRedo()) return;
    undoStack.push(undoCurrent);
    undoCurrent = redoStack.pop()!;
    void applySnap(undoCurrent);
};

document.addEventListener('keydown', (e) => {
    if (e.repeat || !(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    // keep native undo/redo inside a text field the user is editing
    const ae = document.activeElement;
    if (ae instanceof HTMLTextAreaElement || (ae instanceof HTMLInputElement && /^(text|number|search|email|url|tel|password|)$/.test(ae.type))) return;
    e.preventDefault();
    if (k === 'y' || (k === 'z' && e.shiftKey)) doRedo();
    else doUndo();
});
