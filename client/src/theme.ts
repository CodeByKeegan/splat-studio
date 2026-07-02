// Theme engine: named color themes applied as CSS custom properties on <html>.
// Built-in Dark + Light are read-only; custom themes live in localStorage and
// are edited live from the Settings dialog's Appearance page.

export type Scheme = 'dark' | 'light';

export interface Theme {
    id: string;
    name: string;
    scheme: Scheme; // native control rendering + shadow weight
    colors: Record<string, string>; // css var -> #rrggbb
}

interface TokenDef { v: string; label: string; hint?: string }
interface TokenGroup { label: string; tokens: TokenDef[] }

// every user-editable color; derived tints (hovers, badges, overlays) mix from these in CSS
export const TOKEN_GROUPS: TokenGroup[] = [
    {
        label: 'Surfaces',
        tokens: [
            { v: '--bg', label: 'Window', hint: 'Window background + tab strip' },
            { v: '--bg-panel', label: 'Panels', hint: 'Panel and dialog background' },
            { v: '--bg-input', label: 'Controls', hint: 'Inputs, selects, buttons' },
            { v: '--bg-deep', label: 'Console', hint: 'Job log background' },
            { v: '--border', label: 'Borders' }
        ]
    },
    {
        label: 'Text',
        tokens: [
            { v: '--text', label: 'Text' },
            { v: '--text-dim', label: 'Muted text', hint: 'Labels, hints, secondary text' }
        ]
    },
    {
        label: 'Accents',
        tokens: [
            { v: '--accent', label: 'Accent', hint: 'Primary buttons, links, splat tags' },
            { v: '--selection', label: 'Selection & focus', hint: 'Selected items, focus rings, active tools' },
            { v: '--accent-2', label: 'Collision accent', hint: 'Collision wireframe tags + group actions' },
            { v: '--purple', label: 'Render hue', hint: 'Render/Viewer panel dot, LOD tags' },
            { v: '--orange', label: 'Job hue', hint: 'Job panel dot, voxel tags' },
            { v: '--teal', label: 'Generator hue', hint: 'Generator file tags' }
        ]
    },
    {
        label: 'Status',
        tokens: [
            { v: '--ok', label: 'Success' },
            { v: '--warn', label: 'Warning' },
            { v: '--error', label: 'Error' }
        ]
    }
];
const TOKENS = TOKEN_GROUPS.flatMap((g) => g.tokens.map((t) => t.v));

const DARK: Theme = {
    id: 'dark',
    name: 'Dark',
    scheme: 'dark',
    colors: {
        '--bg': '#14161a', '--bg-panel': '#1c1f25', '--bg-input': '#262a32', '--bg-deep': '#0d0f12', '--border': '#343a45',
        '--text': '#d7dce4', '--text-dim': '#8a93a3',
        '--accent': '#4d9fff', '--selection': '#4d9fff', '--accent-2': '#00ff66',
        '--purple': '#c792ea', '--orange': '#ff9e40', '--teal': '#5dd1c0',
        '--ok': '#41d97e', '--warn': '#e0a838', '--error': '#ff5d5d'
    }
};
const LIGHT: Theme = {
    id: 'light',
    name: 'Light',
    scheme: 'light',
    colors: {
        '--bg': '#e9ebef', '--bg-panel': '#f7f8fa', '--bg-input': '#ffffff', '--bg-deep': '#eef0f4', '--border': '#c8cfda',
        '--text': '#20262f', '--text-dim': '#5c6878',
        '--accent': '#2264c7', '--selection': '#2264c7', '--accent-2': '#0d8a4f',
        '--purple': '#8145d6', '--orange': '#c05f10', '--teal': '#0c8377',
        '--ok': '#178745', '--warn': '#996a00', '--error': '#d13438'
    }
};
const BUILTINS: Theme[] = [DARK, LIGHT];

const THEMES_KEY = 'splat-studio.themes';
const ACTIVE_KEY = 'splat-studio.theme';

let customThemes: Theme[] = (() => {
    try {
        const raw = JSON.parse(localStorage.getItem(THEMES_KEY) ?? '[]') as Theme[];
        return Array.isArray(raw) ? raw.filter((t) => t && t.id && t.name && t.colors) : [];
    } catch { return []; }
})();
let activeId = localStorage.getItem(ACTIVE_KEY) ?? 'dark';

const allThemes = (): Theme[] => [...BUILTINS, ...customThemes];
const themeById = (id: string): Theme | undefined => allThemes().find((t) => t.id === id);
const isBuiltIn = (t: Theme): boolean => BUILTINS.some((b) => b.id === t.id);
const activeTheme = (): Theme => themeById(activeId) ?? DARK;
const baseOf = (t: Theme): Theme => (t.scheme === 'light' ? LIGHT : DARK);

const saveCustom = (): void => localStorage.setItem(THEMES_KEY, JSON.stringify(customThemes));
const saveActive = (): void => localStorage.setItem(ACTIVE_KEY, activeId);

// contrast ink for text on a colored fill (accent buttons etc.)
const onColor = (hex: string): string => {
    const n = parseInt(hex.replace('#', ''), 16);
    const lin = (c: number): number => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.197 ? '#0b0f17' : '#ffffff'; // crossover where both inks contrast equally
};

function applyTheme(t: Theme): void {
    const root = document.documentElement;
    const c = (v: string): string => t.colors[v] ?? baseOf(t).colors[v];
    for (const v of TOKENS) root.style.setProperty(v, c(v));
    root.style.setProperty('--on-accent', onColor(c('--accent')));
    root.style.setProperty('--on-accent-2', onColor(c('--accent-2')));
    root.style.setProperty('--on-warn', onColor(c('--warn')));
    root.dataset.theme = t.scheme;
    root.style.colorScheme = t.scheme;
}

export function applyActiveTheme(): void { applyTheme(activeTheme()); }

// ---------- Settings ▸ Appearance UI ----------
interface InitOpts {
    promptText: (title: string, opts?: { value?: string; okLabel?: string; placeholder?: string }) => Promise<string | null>;
    showToast: (message: string, isError?: boolean) => void;
}

export function initThemeSettings({ promptText, showToast }: InitOpts): void {
    const q = <T extends HTMLElement>(sel: string): T => {
        const el = document.querySelector<T>(sel);
        if (!el) throw new Error(`missing settings element ${sel}`);
        return el;
    };
    // theme controls carry no ids on purpose — keeps them out of the persisted
    // form state and the undo snapshots (the theme engine owns its own storage)
    const sel = q<HTMLSelectElement>('.theme-select');
    const btnNew = q<HTMLButtonElement>('.theme-new');
    const btnRename = q<HTMLButtonElement>('.theme-rename');
    const btnDelete = q<HTMLButtonElement>('.theme-delete');
    const schemeSel = q<HTMLSelectElement>('.theme-scheme');
    const schemeRow = q<HTMLElement>('.theme-scheme-row');
    const btnReset = q<HTMLButtonElement>('.theme-reset');
    const editor = q<HTMLDivElement>('.theme-editor');
    const roHint = q<HTMLElement>('.theme-ro-hint');

    let deleteArmTimer = 0;
    const disarmDelete = (): void => { clearTimeout(deleteArmTimer); btnDelete.classList.remove('armed'); btnDelete.textContent = 'Delete'; };

    const rebuildSelect = (): void => {
        sel.innerHTML = '';
        for (const t of allThemes()) {
            const o = document.createElement('option');
            o.value = t.id;
            o.textContent = isBuiltIn(t) ? `${t.name} (built-in)` : t.name;
            sel.appendChild(o);
        }
        sel.value = activeId;
    };

    const rebuildEditor = (): void => {
        const t = activeTheme();
        const ro = isBuiltIn(t);
        roHint.classList.toggle('hidden', !ro);
        schemeRow.classList.toggle('hidden', ro);
        btnRename.disabled = ro;
        btnDelete.disabled = ro;
        btnReset.disabled = ro;
        schemeSel.value = t.scheme;
        editor.innerHTML = '';
        for (const g of TOKEN_GROUPS) {
            const head = document.createElement('div');
            head.className = 'group';
            head.textContent = g.label;
            editor.appendChild(head);
            for (const tok of g.tokens) {
                const row = document.createElement('div');
                row.className = 'theme-color-row';
                if (tok.hint) row.title = tok.hint;
                const label = document.createElement('span');
                label.textContent = tok.label;
                const swatch = document.createElement('input');
                swatch.type = 'color';
                const hex = document.createElement('input');
                hex.type = 'text';
                hex.spellcheck = false;
                const val = t.colors[tok.v] ?? baseOf(t).colors[tok.v];
                swatch.value = val;
                hex.value = val;
                swatch.disabled = ro;
                hex.disabled = ro;
                const setToken = (v: string): void => {
                    t.colors[tok.v] = v;
                    swatch.value = v;
                    hex.value = v;
                    applyTheme(t);
                    saveCustom();
                };
                swatch.oninput = () => setToken(swatch.value);
                hex.onchange = () => {
                    const m = /^#?([0-9a-f]{6})$/i.exec(hex.value.trim());
                    if (m) setToken(`#${m[1].toLowerCase()}`);
                    else hex.value = t.colors[tok.v] ?? baseOf(t).colors[tok.v]; // invalid → revert
                };
                row.append(label, swatch, hex);
                editor.appendChild(row);
            }
        }
    };

    const selectTheme = (id: string): void => {
        activeId = themeById(id) ? id : 'dark';
        saveActive();
        applyActiveTheme();
        disarmDelete();
        rebuildSelect();
        rebuildEditor();
    };

    sel.onchange = () => selectTheme(sel.value);

    btnNew.onclick = async () => {
        const src = activeTheme();
        const name = await promptText('New theme name', { value: `${src.name} copy`, okLabel: 'Create' });
        if (!name) return;
        const t: Theme = { id: `c${Date.now().toString(36)}`, name, scheme: src.scheme, colors: { ...baseOf(src).colors, ...src.colors } };
        customThemes.push(t);
        saveCustom();
        selectTheme(t.id);
        showToast(`Theme "${name}" created — customize it below`);
    };

    btnRename.onclick = async () => {
        const t = activeTheme();
        if (isBuiltIn(t)) return;
        const name = await promptText('Rename theme', { value: t.name, okLabel: 'Rename' });
        if (!name) return;
        t.name = name;
        saveCustom();
        rebuildSelect();
    };

    // two-step delete: first click arms the button, second click within 3 s deletes
    btnDelete.onclick = () => {
        const t = activeTheme();
        if (isBuiltIn(t)) return;
        if (!btnDelete.classList.contains('armed')) {
            btnDelete.classList.add('armed');
            btnDelete.textContent = 'Sure?';
            deleteArmTimer = window.setTimeout(disarmDelete, 3000);
            return;
        }
        disarmDelete();
        customThemes = customThemes.filter((x) => x.id !== t.id);
        saveCustom();
        selectTheme(t.scheme); // fall back to the built-in of the same scheme
        showToast(`Theme "${t.name}" deleted`);
    };

    schemeSel.onchange = () => {
        const t = activeTheme();
        if (isBuiltIn(t)) return;
        t.scheme = schemeSel.value === 'light' ? 'light' : 'dark';
        saveCustom();
        applyTheme(t);
    };

    btnReset.onclick = () => {
        const t = activeTheme();
        if (isBuiltIn(t)) return;
        t.colors = { ...baseOf(t).colors };
        saveCustom();
        applyTheme(t);
        rebuildEditor();
        showToast('Colors reset to the base palette');
    };

    rebuildSelect();
    rebuildEditor();
}
