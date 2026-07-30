// Small UI primitives shared by every panel: toasts, the in-app prompt, and
// number/size formatters.
import { $ } from './dom';

// transient status toast (errors persist longer)
export const showToast = (message: string, isError = false): void => {
    const toastStack = $<HTMLDivElement>('toast-stack');
    const el = document.createElement('div');
    el.className = isError ? 'toast error' : 'toast';
    el.textContent = message;
    toastStack.appendChild(el);
    while (toastStack.children.length > 4) toastStack.firstChild?.remove();
    setTimeout(() => el.remove(), isError ? 8000 : 4000);
};

// In-app text prompt — Electron's renderer has no window.prompt(). Resolves the
// trimmed value, or null if cancelled.
export const promptText = (title: string, opts: { value?: string; okLabel?: string; placeholder?: string } = {}): Promise<string | null> =>
    new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        const modal = document.createElement('div');
        modal.className = 'modal';
        const h = document.createElement('div');
        h.className = 'modal-title';
        h.textContent = title;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = opts.value ?? '';
        if (opts.placeholder) input.placeholder = opts.placeholder;
        const row = document.createElement('div');
        row.className = 'modal-row';
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        const ok = document.createElement('button');
        ok.className = 'primary';
        ok.textContent = opts.okLabel ?? 'OK';
        row.append(cancel, ok);
        modal.append(h, input, row);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        input.focus();
        input.select();

        let done = false;
        const close = (value: string | null): void => {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey, true);
            backdrop.remove();
            resolve(value);
        };
        const submit = (): void => close(input.value.trim() || null);
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== 'Enter' && e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            close(e.key === 'Enter' ? (input.value.trim() || null) : null);
        };
        document.addEventListener('keydown', onKey, true);
        backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(null); });
        cancel.onclick = () => close(null);
        ok.onclick = submit;
    });

// Two-stage confirm for destructive/heavy buttons: the first confirm() arms the
// button (.armed class + label swap, auto-disarming after ttl ms); a second call
// within the window disarms and returns true. disarm() resets it externally.
export interface ArmedConfirm { confirm: (armLabel?: string) => boolean; disarm: () => void }
export const twoStageConfirm = (
    btn: HTMLButtonElement,
    opts: { armLabel?: string; resetLabel?: string; ttl?: number; onArm?: () => void; onDisarm?: () => void } = {}
): ArmedConfirm => {
    const resetLabel = opts.resetLabel ?? btn.textContent ?? '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = (): void => {
        clearTimeout(timer);
        btn.classList.remove('armed');
        if (opts.onDisarm) opts.onDisarm();
        else btn.textContent = resetLabel;
    };
    const confirm = (armLabel?: string): boolean => {
        if (btn.classList.contains('armed')) { disarm(); return true; }
        btn.classList.add('armed');
        if (opts.onArm) opts.onArm();
        else btn.textContent = armLabel ?? opts.armLabel ?? resetLabel;
        timer = setTimeout(disarm, opts.ttl ?? 2500);
        return false;
    };
    return { confirm, disarm };
};

// bytes -> human size ('1.2 GB')
export const fmtSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

// gaussian count -> compact form ('4.1M')
export const fmtCount = (n: number): string => {
    if (n < 1000) return String(n);
    if (n < 1e6) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
    return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
};

// blank input -> null, else Number (region/edit box fields)
export const numOrNull = (el: HTMLInputElement): number | null => el.value.trim() === '' ? null : Number(el.value);

// path -> basename, for compact file labels
export const baseLabel = (n: string): string => n.split('/').pop() ?? n;

/** every visible number input in the panel must hold a valid value */
export const panelValid = (panelId: string): boolean => {
    for (const input of document.querySelectorAll<HTMLInputElement>(`#${panelId} input[type=number]`)) {
        if (input.closest('.hidden')) continue;
        if (!input.reportValidity()) return false;
    }
    return true;
};
