// Render panel: WebP camera/image options, the in-viewport render frustum
// preview, and the render run.
import * as api from './api';
import { $, renderInput } from './dom';
import { viewer } from './state';
import { showToast, panelValid } from './ui';
import { panelActive, refreshCameraViewHint } from './dockview';
import { rebuildSceneList } from './viewport';
import { runJob } from './jobs';

const renderRun = $<HTMLButtonElement>('render-run');

// per-axis triplet fields <-> the "x,y,z" strings the CLI/API contract uses
export const vecFieldIds = (base: string): string[] => [`${base}-x`, `${base}-y`, `${base}-z`];
const readVecField = (base: string): string => vecFieldIds(base).map((id) => String(Number($<HTMLInputElement>(id).value) || 0)).join(',');
export const writeVecField = (base: string, csv: string): void => {
    const parts = csv.split(',');
    vecFieldIds(base).forEach((id, i) => { $<HTMLInputElement>(id).value = String(Number(parts[i]) || 0); });
};

// WebP: grab the viewer camera, converted to CLI render space
$<HTMLButtonElement>('webp-from-viewer').onclick = () => {
    if (!viewer) return showToast('Viewer is still starting up', true);
    const pose = viewer.cameraRenderPose();
    writeVecField('webp-camera', pose.camera);
    writeVecField('webp-lookat', pose.lookAt);
    updateRenderFrustum();
    showToast('Camera set from viewer — adjust if needed');
};

// blank field by id -> undefined, else trimmed string / Number
const strOrUndef = (id: string): string | undefined => {
    const v = $<HTMLInputElement>(id).value.trim();
    return v === '' ? undefined : v;
};
const numOrUndef = (id: string): number | undefined => {
    const v = $<HTMLInputElement>(id).value.trim();
    return v === '' ? undefined : Number(v);
};

const webpImageOptions = (): api.ImageOptions => ({
    camera: readVecField('webp-camera'),
    lookAt: readVecField('webp-lookat'),
    fov: numOrUndef('webp-fov'),
    resolution: strOrUndef('webp-resolution'),
    background: strOrUndef('webp-background'),
    projection: $<HTMLSelectElement>('webp-projection').value as 'pinhole' | 'equirect',
    fStop: numOrUndef('webp-fstop'),
    focusDistance: numOrUndef('webp-focus'),
    cameraEnd: strOrUndef('webp-cameraend'),
    shutter: numOrUndef('webp-shutter'),
    motionSamples: numOrUndef('webp-motionsamples')
});

// the Render panel is the shown tab in its group (gates the render frustum + camera view)
const renderActive = (): boolean => panelActive('panel-render');

// show the WebP render camera as a frustum in the viewport while the Render tab is active
export const updateRenderFrustum = (): void => {
    if (!viewer) return;
    const m = /^(\d+)x(\d+)$/i.exec($<HTMLInputElement>('webp-resolution').value.trim());
    const aspect = m ? Number(m[1]) / Number(m[2]) : 16 / 9;
    const equirect = $<HTMLSelectElement>('webp-projection').value === 'equirect';
    viewer.setRenderFrustum(
        readVecField('webp-camera'),
        readVecField('webp-lookat'),
        Number($<HTMLInputElement>('webp-fov').value),
        aspect,
        renderActive() && !equirect
    );
    refreshCameraViewHint(); // show/hide the Camera-view placeholder with the Render tab
};
for (const id of [...vecFieldIds('webp-camera'), ...vecFieldIds('webp-lookat'), 'webp-fov', 'webp-resolution', 'webp-projection']) {
    $(id).addEventListener('input', updateRenderFrustum);
    $(id).addEventListener('change', updateRenderFrustum);
}
// the render-camera scene item appears/disappears with the projection
$('webp-projection').addEventListener('change', () => rebuildSceneList());

// ---------- Render panel: render a WebP image ----------
renderRun.onclick = () => {
    const input = renderInput.value;
    if (!input) return showToast('Pick a file to render first', true);
    if (!panelValid('panel-render')) return;
    void runJob(() => api.startConvert({
        input,
        format: 'webp',
        options: {
            device: $<HTMLSelectElement>('render-device').value,
            image: webpImageOptions()
        }
    }), renderRun);
};
