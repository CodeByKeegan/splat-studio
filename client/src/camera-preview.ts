// Live "Camera view" panel driver: a second camera renders the WebP render
// pose to a small RenderTarget and blits the readback into a 2D canvas.
import * as pc from 'playcanvas';
import { flipRowsBottomUp } from './line-meshes';

/** The WebP render camera's pose in viewer space (what the preview frames). */
export type RenderFrustumPose = { camera: pc.Vec3; lookAt: pc.Vec3; fov: number; aspect: number };

/**
 * Drives a live preview of the WebP render camera into a 2D canvas. The
 * preview camera renders only the WORLD layer (splat) — no gizmos/markers/
 * frustum, which all live on the immediate layer — to a small RenderTarget;
 * its pixels are read back (throttled, one read in flight) and drawn into
 * the target canvas.
 */
export class CameraPreview {
    private rt: pc.RenderTarget | null = null;
    private tex: pc.Texture | null = null;
    private cam: pc.Entity | null = null;
    private ctx: CanvasRenderingContext2D | null = null;
    private img: ImageData | null = null; // reused readback buffer
    private w = 0;
    private h = 0;
    private reading = false;
    private frame = 0;
    private update: (() => void) | null = null;

    constructor(private app: pc.AppBase, private getFrustum: () => RenderFrustumPose | null) {}

    setup(canvas: HTMLCanvasElement, w = 320, h = 180): void {
        this.teardown();
        const device = this.app.graphicsDevice;
        this.tex = new pc.Texture(device, {
            name: 'webp-preview', width: w, height: h, format: pc.PIXELFORMAT_RGBA8, mipmaps: false,
            minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE
        });
        this.rt = new pc.RenderTarget({ colorBuffer: this.tex, depth: true, samples: 1 });
        const cam = new pc.Entity('webp-preview-cam');
        cam.addComponent('camera', {
            clearColor: new pc.Color(0.055, 0.06, 0.07),
            fov: 60,
            layers: [pc.LAYERID_WORLD], // splat only — excludes immediate-layer gizmos/markers/frustum
            renderTarget: this.rt
        });
        cam.enabled = false;
        this.app.root.addChild(cam);
        this.cam = cam;
        canvas.width = w; canvas.height = h;
        this.ctx = canvas.getContext('2d');
        this.img = this.ctx ? this.ctx.createImageData(w, h) : null;
        this.w = w; this.h = h;
        this.update = () => this.updateView();
        this.app.on('update', this.update);
    }

    teardown(): void {
        if (this.update) { this.app.off('update', this.update); this.update = null; }
        this.cam?.destroy();
        this.rt?.destroy();
        this.tex?.destroy();
        this.cam = null; this.rt = null; this.tex = null;
        this.ctx = null; this.img = null; this.reading = false;
    }

    private updateView(): void {
        const rf = this.getFrustum(), cam = this.cam, rt = this.rt, tex = this.tex;
        const w = this.w, h = this.h;
        if (!rf || !cam || !rt || !tex || !this.ctx || !this.img) { if (cam) cam.enabled = false; return; }
        cam.enabled = true;
        cam.setPosition(rf.camera);
        cam.lookAt(rf.lookAt);
        const cc = cam.camera as pc.CameraComponent;
        cc.fov = rf.fov;
        cc.aspectRatio = w / h;
        // throttle the readback: ~15-20fps, never two reads in flight, one reused buffer
        if (this.reading || (this.frame++ % 3) !== 0) return;
        this.reading = true;
        tex.read(0, 0, w, h, { renderTarget: rt }).then((data) => {
            this.reading = false;
            const ctx = this.ctx, img = this.img;
            if (!ctx || !img || !data) return;
            flipRowsBottomUp(data, img.data, w, h); // RT is bottom-up
            ctx.putImageData(img, 0, 0);
        }).catch(() => { this.reading = false; });
    }
}
