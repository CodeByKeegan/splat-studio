// Persisted form state: every id'd control's value round-trips through
// localStorage via one delegated document listener. Controls owned by the
// server/desktop (MCP consent, update prefs) are excluded — they sync from
// their owners instead.
import { hooks } from './state';

export const FORM_KEY = 'splat-studio.form';
// selects whose options come from the workspace — restored after the file list loads
export const FILE_SELECT_IDS = new Set(['convert-input', 'lod-input', 'render-input', 'collision-input', 'analyze-input', 'edit-input']);
// controls owned by the server/desktop (MCP consent, update prefs)
export const EXTERNAL_STATE_IDS = new Set(['mcp-control', 'update-channel', 'update-auto']);
export const formState: Record<string, string | boolean> = (() => {
    try { return JSON.parse(localStorage.getItem(FORM_KEY) ?? '{}'); } catch { return {}; }
})();

// bound to document: panels live in separate dock groups, so a single
// delegated listener survives any re-docking (change bubbles to document)
document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement) || !t.id) return;
    if (t.id === 'files-select-all') return; // transient bulk-select state, not a form value
    if (!EXTERNAL_STATE_IDS.has(t.id)) {
        formState[t.id] = t instanceof HTMLInputElement && t.type === 'checkbox' ? t.checked : t.value;
        localStorage.setItem(FORM_KEY, JSON.stringify(formState));
    }
    hooks.scheduleUndoCapture(); // record an undo step for this committed change
});

// re-apply persisted values (file selects wait for the listing to populate)
export const restoreFormState = (): void => {
    for (const [id, value] of Object.entries(formState)) {
        if (FILE_SELECT_IDS.has(id) || EXTERNAL_STATE_IDS.has(id)) continue;
        const el = document.getElementById(id);
        if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) continue;
        if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = value === true;
        else el.value = String(value);
    }
};
