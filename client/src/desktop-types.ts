// Types for the Electron preload bridge (electron/preload.cjs); absent in the
// browser dev build. Update members are optional so an older shell degrades
// gracefully.
export interface UpdateStatus { phase: string; version?: string; percent?: number; channel?: string; message?: string }
export interface DesktopApi {
    pickFolder(defaultPath?: string): Promise<string | null>;
    persistWorkspace(path: string): Promise<void>;
    openWorkspace(): Promise<void>;
    onChooseWorkspace(cb: () => void): void;
    checkForUpdates?: () => Promise<void>;
    getUpdateChannel?: () => Promise<'stable' | 'beta'>;
    setUpdateChannel?: (c: 'stable' | 'beta') => Promise<'stable' | 'beta'>;
    getUpdateStatus?: () => Promise<UpdateStatus>;
    onUpdateStatus?: (cb: (s: UpdateStatus) => void) => void;
    downloadUpdate?: () => Promise<void>;
    getUpdateAuto?: () => Promise<boolean>;
    setUpdateAuto?: (on: boolean) => Promise<boolean>;
}

