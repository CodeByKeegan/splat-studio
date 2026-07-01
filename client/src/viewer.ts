import * as pc from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import { parseVoxelOctree } from './voxel-parser';
import type { VoxelMeta } from './voxel-parser';

/** Selectable scene-hierarchy objects. 'capsule', 'render-camera' and 'collision-region' carry a gizmo. */
export type SelId = 'none' | 'splat' | 'collision' | 'voxels' | 'capsule' | 'render-camera' | 'collision-region';

/**
 * PlayCanvas viewer: renders a gaussian splat plus its generated collision mesh
 * as a wireframe overlay.
 *
 * Coordinate conventions (verified empirically against splat-transform 2.5.2
 * with an asymmetric test blob — see scripts/axis-test.mjs): the splat lives
 * under `sceneRoot`, which carries the viewer-conventional 180° X rotation of
 * raw Y-down splat data (x, y, z -> x, -y, -z). splat-transform's voxel
 * pipeline converts to Y-up differently — 180° about Z (x, y, z -> -x, -y, z) —
 * so its .collision.glb and --seed-pos differ from viewer world space by
 * exactly 180° about Y. The collision holder therefore defaults to a 180° Y
 * rotation, and camera->seed conversion negates x and z.
 */
export class SplatViewer {
    private app!: pc.AppBase;
    private camera!: pc.Entity;
    private controls: any;
    private sceneRoot!: pc.Entity;
    private collisionHolder!: pc.Entity;
    private wireMaterial!: pc.StandardMaterial;

    private splatEntity: pc.Entity | null = null;
    private splatAsset: pc.Asset | null = null;
    private collisionEntity: pc.Entity | null = null;
    private collisionAsset: pc.Asset | null = null;
    private voxelEntity: pc.Entity | null = null;
    private voxelBounds: pc.BoundingBox | null = null;
    private voxelMesh: pc.Mesh | null = null;
    private voxelVb: pc.VertexBuffer | null = null;
    private voxelMaterial!: pc.StandardMaterial;
    private boundsEntity: pc.Entity | null = null;
    private boundsMaterial!: pc.StandardMaterial;
    private boundsVisible = false;
    private depthMaterial!: pc.StandardMaterial;
    private solidMaterial!: pc.StandardMaterial;
    private collisionSurfMIs: pc.MeshInstance[] = [];
    private collisionStyle: 'xray' | 'hidden' | 'solid' = 'xray';
    /** triangle count of the loaded collision mesh (0 when none) */
    collisionTriangles = 0;
    private seedHolder!: pc.Entity;
    private seedNode!: pc.Entity;
    private seedMarker!: pc.Entity;
    private capsuleEntity!: pc.Entity;
    private capsuleMesh: pc.Mesh | null = null;
    private seedMaterial!: pc.StandardMaterial;
    private capsuleMaterial!: pc.StandardMaterial;
    private gizmo!: pc.TranslateGizmo;
    /** fired while the seed gizmo is dragged; arg is the seed in CLI coords */
    onSeedMove?: (cli: { x: number; y: number; z: number }) => void;
    /** fired when a gizmo drag finishes */
    onSeedMoveEnd?: () => void;
    // edit tools (measure / set-origin): two markers placed by clicking the splat
    private mA!: pc.Entity;
    private mB!: pc.Entity;
    private editMaterial!: pc.StandardMaterial;
    private editMode: 'none' | 'measure' | 'origin' = 'none';
    private gizmoTarget: 'seed' | 'a' | 'b' | 'camera' = 'seed';
    private activeMarker: 'a' | 'b' = 'a';
    private placed = { a: false, b: false };
    // splat gaussian centres (entity-local), for click-to-place ray picking and
    // CPU occlusion of the markers — no collision mesh needed
    private pickCenters: Float32Array | null = null;
    private occCenters: Float32Array | null = null;
    private lastCamKey = '';
    /** fired while a measure/origin marker moves; arg is the A–B distance (world units) */
    onMeasureChange?: (distance: number) => void;
    /** fired after a click places a marker; arg is which marker the next click will set */
    onActiveMarkerChange?: (which: 'a' | 'b') => void;
    /** fired after any edit-marker placement (measure or origin) */
    onEditPlaced?: () => void;
    // WebP render-camera frustum preview (drawn each frame when set)
    private renderFrustum: { camera: pc.Vec3; lookAt: pc.Vec3; fov: number; aspect: number } | null = null;
    private renderCamNode!: pc.Entity; // backing entity the render-camera gizmo attaches to
    private rotGizmo!: pc.RotateGizmo; // rotation gizmo (render camera)
    // scene-hierarchy selection: drives which gizmo (if any) is shown. Nothing
    // selected → no gizmo; the carve capsule only shows while 'capsule' is selected.
    private selected: SelId = 'none';
    private camGizmoMode: 'move' | 'rotate' = 'move';
    private renderCamDist = 1; // camera→lookAt distance, preserved while gizmo-dragging
    private gizmoDragging = false; // suppress external node repositioning mid-drag
    // live "Camera view" panel: a second camera renders the WebP pose to a texture
    private previewRT: pc.RenderTarget | null = null;
    private previewTex: pc.Texture | null = null;
    private previewCam: pc.Entity | null = null;
    private previewCtx: CanvasRenderingContext2D | null = null;
    private previewImg: ImageData | null = null; // reused readback buffer
    private previewW = 0;
    private previewH = 0;
    private previewReading = false;
    private previewFrame = 0;
    private previewUpdate: (() => void) | null = null;
    /** fired when the viewport changes the selection (e.g. clears it on mode change) */
    onSelectionChange?: (id: SelId) => void;
    /** fired while the render-camera gizmo moves/rotates; both vectors in CLI render space */
    onRenderCameraMove?: (camera: { x: number; y: number; z: number }, lookAt: { x: number; y: number; z: number }) => void;
    private splatSeq = 0;
    private collisionSeq = 0;
    private voxelSeq = 0;
    private skyboxSeq = 0;
    private skyboxCubemap: pc.Texture | null = null;
    private skyboxAsset: pc.Asset | null = null;

    // crop-region preview (filter-box / filter-sphere) lives under sceneRoot, in
    // the post-transform output frame the CLI filters operate in
    private cropHolder!: pc.Entity;
    private cropBoxNode!: pc.Entity;
    private cropSphereNode!: pc.Entity;
    private cropMaterial!: pc.StandardMaterial;
    private cropGizmo!: pc.TranslateGizmo;
    private cropMode: 'none' | 'box' | 'sphere' = 'none';
    private cropBoxLast = new pc.Vec3();
    /** live preview of the Convert transform (translate/rotate/scale) on the splat */
    private previewXform: { t: pc.Vec3; r: pc.Vec3; s: number } | null = null;
    /** box reports an incremental drag delta; sphere an absolute centre — both in CLI coords */
    onCropBoxMove?: (delta: { x: number; y: number; z: number }) => void;
    onCropSphereMove?: (centre: { x: number; y: number; z: number }) => void;
    onCropMoveEnd?: () => void;

    // collision region: its own node + gizmo so it never contends with the Convert crop preview
    private regionBoxNode!: pc.Entity;
    private regionMaterial!: pc.StandardMaterial;
    private regionGizmo!: pc.TranslateGizmo;
    /** region drag reports absolute min/max corners in CLI coords */
    onRegionBoxChange?: (min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }) => void;
    onRegionBoxEnd?: () => void;
    private regionGizmoMode: 'move' | 'resize' = 'move';
    private regionHandles: { entity: pc.Entity; axis: 0 | 1 | 2; sign: 1 | -1 }[] = [];
    private regionHandleMat!: pc.StandardMaterial;
    private regionDrag: { axis: 0 | 1 | 2; sign: 1 | -1 } | null = null;

    /** Bundled PlayCanvas engine version (e.g. "2.20.0"), for the Settings/About section. */
    static get engineVersion(): string { return (pc as unknown as { version?: string }).version ?? ''; }

    static async create(canvas: HTMLCanvasElement): Promise<SplatViewer> {
        const viewer = new SplatViewer();
        await viewer.init(canvas);
        return viewer;
    }

    private async init(canvas: HTMLCanvasElement): Promise<void> {
        const device = await pc.createGraphicsDevice(canvas, {
            deviceTypes: [pc.DEVICETYPE_WEBGPU, pc.DEVICETYPE_WEBGL2],
            antialias: false
        });
        device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

        const createOptions = new pc.AppOptions();
        createOptions.graphicsDevice = device;
        createOptions.mouse = new pc.Mouse(canvas);
        createOptions.touch = new pc.TouchDevice(canvas);
        createOptions.keyboard = new pc.Keyboard(window);
        createOptions.componentSystems = [
            pc.RenderComponentSystem,
            pc.CameraComponentSystem,
            pc.LightComponentSystem,
            pc.ScriptComponentSystem,
            pc.GSplatComponentSystem
        ];
        createOptions.resourceHandlers = [
            pc.TextureHandler,
            pc.ContainerHandler,
            pc.ScriptHandler,
            pc.GSplatHandler
        ];

        const app = new pc.AppBase(canvas);
        app.init(createOptions);
        // size from the canvas's container (CSS 100%), not the window — the
        // sidebar is resizable, so the viewport is narrower than the window
        app.setCanvasFillMode(pc.FILLMODE_NONE);
        app.setCanvasResolution(pc.RESOLUTION_AUTO);
        const observer = new ResizeObserver(() => app.resizeCanvas());
        observer.observe(canvas);
        app.on('destroy', () => observer.disconnect());

        this.app = app;

        this.sceneRoot = new pc.Entity('scene-root');
        this.sceneRoot.setLocalEulerAngles(180, 0, 0);
        app.root.addChild(this.sceneRoot);

        this.collisionHolder = new pc.Entity('collision-holder');
        // splat-transform GLBs are R_z(180) of raw splat space; the splat
        // renders as R_x(180) of it — they differ by R_y(180)
        this.collisionHolder.setLocalEulerAngles(0, 180, 0);
        app.root.addChild(this.collisionHolder);

        this.camera = new pc.Entity('camera');
        this.camera.addComponent('camera', {
            clearColor: new pc.Color(0.055, 0.06, 0.07),
            fov: 60,
            toneMapping: pc.TONEMAP_ACES
        });
        this.camera.setLocalPosition(3, 2, 4);
        this.camera.addComponent('script');
        this.controls = (this.camera.script as pc.ScriptComponent).create(CameraControls, {
            properties: {
                // fly is the default: mouse-look + WASD, ideal for inspecting carved
                // interiors from inside. Orbit is opt-in via setCameraMode('orbit').
                enableFly: true,
                enableOrbit: false,
                enablePan: true,
                focusPoint: new pc.Vec3(0, 0.8, 0),
                zoomRange: new pc.Vec2(0.1, 100)
            }
        });
        app.root.addChild(this.camera);

        // headlight for the solid collision mode (gsplats/wireframes are unlit)
        const light = new pc.Entity('headlight');
        light.addComponent('light', {
            type: 'directional',
            intensity: 1.1,
            layers: [pc.LAYERID_IMMEDIATE]
        });
        this.camera.addChild(light);

        this.wireMaterial = new pc.StandardMaterial();
        this.wireMaterial.useLighting = false;
        this.wireMaterial.diffuse = new pc.Color(0, 0, 0);
        this.wireMaterial.emissive = new pc.Color(0, 1, 0.4);
        this.wireMaterial.blendType = pc.BLEND_NORMAL;
        this.wireMaterial.opacity = 0.6;
        this.wireMaterial.depthTest = false;
        this.wireMaterial.depthWrite = false;
        this.wireMaterial.update();

        this.voxelMaterial = new pc.StandardMaterial();
        this.voxelMaterial.useLighting = false;
        this.voxelMaterial.diffuse = new pc.Color(0, 0, 0);
        this.voxelMaterial.emissive = new pc.Color(1, 0.62, 0.25);
        this.voxelMaterial.blendType = pc.BLEND_NORMAL;
        this.voxelMaterial.opacity = 0.35;
        this.voxelMaterial.depthWrite = false;
        this.voxelMaterial.update();

        // axis-aligned bounding-box overlay (drawn as a wireframe unit cube,
        // scaled/positioned to the loaded splat's world AABB)
        this.boundsMaterial = new pc.StandardMaterial();
        this.boundsMaterial.useLighting = false;
        this.boundsMaterial.emissive = new pc.Color(0.45, 0.85, 1);
        this.boundsMaterial.depthTest = false;
        this.boundsMaterial.depthWrite = false;
        this.boundsMaterial.update();

        // depth-only prepass: fills the depth buffer so the wireframe becomes
        // hidden-line instead of X-ray (draws no color)
        this.depthMaterial = new pc.StandardMaterial();
        this.depthMaterial.redWrite = false;
        this.depthMaterial.greenWrite = false;
        this.depthMaterial.blueWrite = false;
        this.depthMaterial.alphaWrite = false;
        this.depthMaterial.depthWrite = true;
        this.depthMaterial.update();

        // lit translucent surface for placement/carve inspection
        this.solidMaterial = new pc.StandardMaterial();
        this.solidMaterial.diffuse = new pc.Color(0.42, 0.55, 0.5);
        this.solidMaterial.opacity = 0.8;
        this.solidMaterial.blendType = pc.BLEND_NORMAL;
        this.solidMaterial.depthWrite = true;
        this.solidMaterial.cull = pc.CULLFACE_NONE;
        this.solidMaterial.twoSidedLighting = true;
        this.solidMaterial.update();

        // ----- seed + carve-capsule preview (a collision-tuning aid) -----
        // its own holder with the same CLI->viewer 180°-Y rotation as collision,
        // so seed coords (typed in CLI space) land where the carve happens —
        // and independent of the collision visibility toggle.
        this.seedHolder = new pc.Entity('seed-holder');
        this.seedHolder.setLocalEulerAngles(0, 180, 0);
        app.root.addChild(this.seedHolder);

        this.seedMaterial = new pc.StandardMaterial();
        this.seedMaterial.useLighting = false;
        this.seedMaterial.emissive = new pc.Color(1, 0.85, 0.1); // yellow
        this.seedMaterial.depthTest = false; // always findable through the splat
        this.seedMaterial.update();

        this.capsuleMaterial = new pc.StandardMaterial();
        this.capsuleMaterial.useLighting = false;
        this.capsuleMaterial.emissive = new pc.Color(0.2, 0.8, 1); // cyan
        this.capsuleMaterial.blendType = pc.BLEND_NORMAL;
        this.capsuleMaterial.opacity = 0.3;
        this.capsuleMaterial.depthWrite = false;
        this.capsuleMaterial.depthTest = false;
        this.capsuleMaterial.cull = pc.CULLFACE_NONE;
        this.capsuleMaterial.update();

        // marker + capsule live under a movable node so one gizmo drags both
        this.seedNode = new pc.Entity('seed-node');
        this.seedHolder.addChild(this.seedNode);

        const seedSphere = pc.Mesh.fromGeometry(device, new pc.SphereGeometry({ radius: 0.12 }));
        this.seedMarker = new pc.Entity('seed-marker');
        this.seedMarker.addComponent('render', { meshInstances: [new pc.MeshInstance(seedSphere, this.seedMaterial)], layers: [pc.LAYERID_IMMEDIATE] });
        this.seedNode.addChild(this.seedMarker);

        this.capsuleEntity = new pc.Entity('seed-capsule');
        this.capsuleEntity.addComponent('render', { meshInstances: [], layers: [pc.LAYERID_IMMEDIATE] });
        this.seedNode.addChild(this.capsuleEntity);

        // translate gizmo to drag the seed; disable the orbit camera while a
        // handle is grabbed, and report the new position back in CLI coords
        const gizmoLayer = pc.Gizmo.createLayer(app);
        this.gizmo = new pc.TranslateGizmo(this.camera.camera as pc.CameraComponent, gizmoLayer);
        this.gizmo.on('pointer:down', (_x: number, _y: number, mi: pc.MeshInstance | null) => {
            if (mi) { this.controls.enabled = false; this.gizmoDragging = true; }
        });
        this.gizmo.on('pointer:up', () => { this.controls.enabled = true; this.gizmoDragging = false; });
        this.gizmo.on('transform:move', () => {
            if (this.gizmoTarget === 'seed') {
                const p = this.seedNode.getPosition();
                this.onSeedMove?.({ x: round(-p.x), y: round(p.y), z: round(-p.z) });
            } else if (this.gizmoTarget === 'camera') {
                this.emitRenderCameraFromNode();
            }
        });
        this.gizmo.on('transform:end', () => { if (this.gizmoTarget === 'seed') this.onSeedMoveEnd?.(); });

        // render-camera backing node + its rotation gizmo (translation reuses this.gizmo)
        this.renderCamNode = new pc.Entity('render-cam-node');
        app.root.addChild(this.renderCamNode);
        this.rotGizmo = new pc.RotateGizmo(this.camera.camera as pc.CameraComponent, gizmoLayer);
        this.rotGizmo.on('pointer:down', (_x: number, _y: number, mi: pc.MeshInstance | null) => { if (mi) { this.controls.enabled = false; this.gizmoDragging = true; } });
        this.rotGizmo.on('pointer:up', () => { this.controls.enabled = true; this.gizmoDragging = false; });
        this.rotGizmo.on('transform:move', () => { if (this.selected === 'render-camera') this.emitRenderCameraFromNode(); });
        this.rotGizmo.detach();

        // edit markers (measure / set-origin) live in world space so the distance
        // between them is the real splat distance (sceneRoot's flip is a rotation).
        // unit-radius spheres scaled per frame to a constant on-screen size.
        this.editMaterial = new pc.StandardMaterial();
        this.editMaterial.useLighting = false;
        this.editMaterial.depthTest = false; // markers hidden behind the splat via CPU occlusion, not the depth buffer
        this.editMaterial.update();
        const marker = (name: string, color: pc.Color): pc.Entity => {
            const mat = this.editMaterial.clone(); mat.emissive = color; mat.update();
            const mesh = pc.Mesh.fromGeometry(device, new pc.SphereGeometry({ radius: 1 }));
            const e = new pc.Entity(name);
            e.addComponent('render', { meshInstances: [new pc.MeshInstance(mesh, mat)], layers: [pc.LAYERID_IMMEDIATE] });
            e.enabled = false;
            app.root.addChild(e);
            return e;
        };
        this.mA = marker('measure-a', new pc.Color(0.2, 1, 0.45));
        this.mB = marker('measure-b', new pc.Color(1, 0.5, 0.2));
        // place a marker by clicking the splat surface (no gizmo drag)
        this.installClickToPlace(canvas);
        app.on('update', () => {
            if (this.editMode !== 'none') this.updateEditMarkers();
            if (this.renderFrustum) this.drawRenderFrustum();
            this.updateRegionHandles();
        });

        // ----- crop-region preview (filter-box / filter-sphere) -----
        this.cropHolder = new pc.Entity('crop-holder');
        this.sceneRoot.addChild(this.cropHolder);

        this.cropMaterial = new pc.StandardMaterial();
        this.cropMaterial.useLighting = false;
        this.cropMaterial.emissive = new pc.Color(0.3, 0.7, 1);
        this.cropMaterial.blendType = pc.BLEND_NORMAL;
        this.cropMaterial.opacity = 0.9;
        this.cropMaterial.depthTest = false; // always findable through the splat
        this.cropMaterial.depthWrite = false;
        this.cropMaterial.update();

        this.cropBoxNode = new pc.Entity('crop-box');
        const boxMi = new pc.MeshInstance(pc.Mesh.fromGeometry(device, new pc.BoxGeometry()), this.cropMaterial);
        this.cropBoxNode.addComponent('render', { meshInstances: [boxMi], layers: [pc.LAYERID_IMMEDIATE] });
        boxMi.renderStyle = pc.RENDERSTYLE_WIREFRAME;
        this.cropBoxNode.enabled = false;
        this.cropHolder.addChild(this.cropBoxNode);

        this.cropSphereNode = new pc.Entity('crop-sphere');
        const sphMi = new pc.MeshInstance(pc.Mesh.fromGeometry(device, new pc.SphereGeometry({ radius: 1 })), this.cropMaterial);
        this.cropSphereNode.addComponent('render', { meshInstances: [sphMi], layers: [pc.LAYERID_IMMEDIATE] });
        sphMi.renderStyle = pc.RENDERSTYLE_WIREFRAME;
        this.cropSphereNode.enabled = false;
        this.cropHolder.addChild(this.cropSphereNode);

        // one shared gizmo for whichever crop is active (box takes priority)
        this.cropGizmo = new pc.TranslateGizmo(this.camera.camera as pc.CameraComponent, gizmoLayer);
        this.cropGizmo.on('pointer:down', (_x: number, _y: number, mi: pc.MeshInstance | null) => {
            if (!mi) return;
            this.controls.enabled = false;
            this.cropBoxLast.copy(this.cropBoxNode.getLocalPosition());
        });
        this.cropGizmo.on('pointer:up', () => { this.controls.enabled = true; });
        this.cropGizmo.on('transform:move', () => {
            if (this.cropMode === 'box') {
                const p = this.cropBoxNode.getLocalPosition();
                this.onCropBoxMove?.({ x: round(p.x - this.cropBoxLast.x), y: round(p.y - this.cropBoxLast.y), z: round(p.z - this.cropBoxLast.z) });
                this.cropBoxLast.copy(p);
            } else if (this.cropMode === 'sphere') {
                const p = this.cropSphereNode.getLocalPosition();
                this.onCropSphereMove?.({ x: round(p.x), y: round(p.y), z: round(p.z) });
            }
        });
        this.cropGizmo.on('transform:end', () => this.onCropMoveEnd?.());
        this.cropGizmo.detach();

        // ----- collision region box (dedicated node under cropHolder = CLI space) -----
        this.regionMaterial = new pc.StandardMaterial();
        this.regionMaterial.useLighting = false;
        this.regionMaterial.emissive = new pc.Color(0.95, 0.6, 0.15); // amber, distinct from the cyan crop/bounds
        this.regionMaterial.blendType = pc.BLEND_NORMAL;
        this.regionMaterial.opacity = 0.95;
        this.regionMaterial.depthTest = false;
        this.regionMaterial.depthWrite = false;
        this.regionMaterial.update();

        this.regionBoxNode = new pc.Entity('region-box');
        const regMi = new pc.MeshInstance(pc.Mesh.fromGeometry(device, new pc.BoxGeometry()), this.regionMaterial);
        this.regionBoxNode.addComponent('render', { meshInstances: [regMi], layers: [pc.LAYERID_IMMEDIATE] });
        regMi.renderStyle = pc.RENDERSTYLE_WIREFRAME;
        this.regionBoxNode.enabled = false;
        this.cropHolder.addChild(this.regionBoxNode);

        this.regionGizmo = new pc.TranslateGizmo(this.camera.camera as pc.CameraComponent, gizmoLayer);
        this.regionGizmo.on('pointer:down', (_x: number, _y: number, mi: pc.MeshInstance | null) => { if (mi) this.controls.enabled = false; });
        this.regionGizmo.on('pointer:up', () => { this.controls.enabled = true; });
        this.regionGizmo.on('transform:move', () => this.emitRegionBox());
        this.regionGizmo.on('transform:end', () => { this.emitRegionBox(); this.onRegionBoxEnd?.(); });
        this.regionGizmo.detach();

        // six face handles (Resize mode): drag one face, the opposite stays pinned
        this.regionHandleMat = new pc.StandardMaterial();
        this.regionHandleMat.useLighting = false;
        this.regionHandleMat.emissive = new pc.Color(1, 0.85, 0.3);
        this.regionHandleMat.depthTest = false;
        this.regionHandleMat.depthWrite = false;
        this.regionHandleMat.update();
        for (const axis of [0, 1, 2] as (0 | 1 | 2)[]) {
            for (const sign of [1, -1] as (1 | -1)[]) {
                const h = new pc.Entity(`region-handle-${axis}-${sign}`);
                const mi = new pc.MeshInstance(pc.Mesh.fromGeometry(device, new pc.BoxGeometry()), this.regionHandleMat);
                h.addComponent('render', { meshInstances: [mi], layers: [pc.LAYERID_IMMEDIATE] });
                h.enabled = false;
                this.cropHolder.addChild(h);
                this.regionHandles.push({ entity: h, axis, sign });
            }
        }
        this.installRegionHandleDrag(canvas);

        this.applySelection(); // nothing selected → no gizmo, capsule/seed hidden

        app.start();
    }

    private loadAsset(url: string, filename: string, type: string): Promise<pc.Asset> {
        return new Promise((resolve, reject) => {
            this.app.assets.loadFromUrlAndFilename(url, filename, type, (err, asset) => {
                if (err || !asset) reject(new Error(String(err ?? 'load failed')));
                else resolve(asset);
            });
        });
    }

    /** @returns true if this load applied; false if superseded by a newer load or a remove. */
    async loadSplat(url: string, filename: string): Promise<boolean> {
        this.clearSplat(); // bumps splatSeq, superseding any in-flight load (incl. a remove)
        const seq = this.splatSeq;
        const asset = await this.loadAsset(url, filename, 'gsplat');
        if (seq !== this.splatSeq) {
            // superseded by a newer load or a remove; don't unload an asset the
            // winner may own (same-url loads dedupe to one asset object)
            if (asset !== this.splatAsset) {
                this.app.assets.remove(asset);
                asset.unload();
            }
            return false;
        }
        const entity = new pc.Entity(filename);
        entity.addComponent('gsplat', { asset });
        this.sceneRoot.addChild(entity);
        this.splatEntity = entity;
        this.splatAsset = asset;
        this.buildCenterCaches(asset);
        this.applyPreviewXform(); // a newly loaded splat inherits the active preview transform

        // customAabb appears once the engine has run a frame; don't block the
        // load on that (rAF stalls entirely in hidden tabs) — frame when ready.
        void this.frameWhenReady(entity);
        return true;
    }

    private async frameWhenReady(entity: pc.Entity): Promise<void> {
        for (let i = 0; i < 100; i++) {
            if (this.splatEntity !== entity) return; // replaced meanwhile
            if (entity.gsplat?.customAabb) break;
            await new Promise((r) => setTimeout(r, 50));
        }
        if (this.splatEntity === entity) {
            this.frame();
            this.refreshBounds(); // AABB is known now
        }
    }

    /** @returns true if this load applied; false if superseded by a newer load or a remove. */
    async loadCollision(url: string, filename: string): Promise<boolean> {
        this.clearCollision(); // bumps collisionSeq, superseding any in-flight load
        const seq = this.collisionSeq;
        const asset = await this.loadAsset(url, filename, 'container');
        if (seq !== this.collisionSeq) {
            if (asset !== this.collisionAsset) {
                this.app.assets.remove(asset);
                asset.unload();
            }
            return false;
        }
        const entity = (asset.resource as pc.ContainerResource).instantiateRenderEntity();
        // a prior visibility toggle-off must not hide a freshly loaded mesh
        this.collisionHolder.enabled = true;
        this.collisionHolder.addChild(entity);

        // each mesh gets two instances: a surface pass (depth-only or lit solid,
        // opaque sub-layer renders first) and the wireframe (blended, second).
        // Build FRESH instances before reassigning: the meshInstances setter
        // destroys the previous ones (our extra refs keep the meshes alive),
        // and it stamps the component's renderStyle onto the new array — so
        // wireframe style must be applied after assignment.
        this.collisionSurfMIs = [];
        this.collisionTriangles = 0;
        for (const component of entity.findComponents('render') as pc.RenderComponent[]) {
            component.layers = [pc.LAYERID_IMMEDIATE];
            const wires: pc.MeshInstance[] = [];
            const surfs: pc.MeshInstance[] = [];
            for (const mi of component.meshInstances) {
                wires.push(new pc.MeshInstance(mi.mesh, this.wireMaterial, mi.node));
                surfs.push(new pc.MeshInstance(mi.mesh, this.depthMaterial, mi.node));
                this.collisionTriangles += Math.floor(mi.mesh.primitive[0].count / 3);
            }
            component.meshInstances = [...surfs, ...wires];
            for (const wire of wires) {
                // setter triggers mesh.generateWireframe(): dedup'd line index buffer
                wire.renderStyle = pc.RENDERSTYLE_WIREFRAME;
            }
            this.collisionSurfMIs.push(...surfs);
        }

        this.collisionEntity = entity;
        this.collisionAsset = asset;
        this.applyCollisionStyle();
        if (!this.splatEntity) this.frame();
        return true;
    }

    /**
     * xray: wireframe through everything (small meshes);
     * hidden: hidden-line wireframe — depth prepass culls back edges (dense meshes);
     * solid: lit translucent surface + hidden-line wires (placement/carve checks).
     */
    setCollisionStyle(style: 'xray' | 'hidden' | 'solid'): void {
        this.collisionStyle = style;
        this.applyCollisionStyle();
    }

    private applyCollisionStyle(): void {
        const style = this.collisionStyle;
        this.wireMaterial.depthTest = style !== 'xray';
        this.wireMaterial.update();
        for (const mi of this.collisionSurfMIs) {
            mi.visible = style !== 'xray';
            mi.material = style === 'solid' ? this.solidMaterial : this.depthMaterial;
        }
    }

    /**
     * Renders a sparse voxel octree (.voxel.json + sibling .voxel.bin) as
     * hardware-instanced translucent boxes. Box transforms are baked from
     * splat-transform's voxel space into viewer space (180° about Y), since
     * per-instance matrices replace the node's world transform.
     */
    async loadVoxels(url: string): Promise<{ count: number; truncated: boolean; applied: boolean }> {
        this.clearVoxels(); // bumps voxelSeq, superseding any in-flight load
        const seq = this.voxelSeq;

        const meta = (await (await fetch(url)).json()) as VoxelMeta;
        const binUrl = url.replace(/\.voxel\.json$/, '.voxel.bin');
        const bin = await (await fetch(binUrl)).arrayBuffer();
        if (seq !== this.voxelSeq) return { count: 0, truncated: false, applied: false };

        const { boxes, count, truncated } = parseVoxelOctree(meta, bin);

        // mat4 per instance: diag(-sx, sy, -sz) + translation (-cx, cy, -cz)
        // is R_y(180) · translate · scale — det > 0, so winding is preserved
        const matrices = new Float32Array(count * 16);
        for (let i = 0; i < count; i++) {
            const b = i * 6;
            const m = i * 16;
            matrices[m] = -boxes[b + 3];
            matrices[m + 5] = boxes[b + 4];
            matrices[m + 10] = -boxes[b + 5];
            matrices[m + 12] = -boxes[b];
            matrices[m + 13] = boxes[b + 1];
            matrices[m + 14] = -boxes[b + 2];
            matrices[m + 15] = 1;
        }

        const device = this.app.graphicsDevice;
        const mesh = pc.Mesh.fromGeometry(device, new pc.BoxGeometry());
        const mi = new pc.MeshInstance(mesh, this.voxelMaterial);
        const vb = new pc.VertexBuffer(
            device,
            pc.VertexFormat.getDefaultInstancingFormat(device),
            count,
            { data: matrices.buffer }
        );
        mi.setInstancing(vb);
        this.voxelMesh = mesh;
        this.voxelVb = vb;

        const entity = new pc.Entity('voxels');
        entity.addComponent('render', {
            meshInstances: [mi],
            layers: [pc.LAYERID_IMMEDIATE]
        });
        this.app.root.addChild(entity);
        this.voxelEntity = entity;

        // bounds in viewer space (x and z negate, so recompute min/max)
        const [ax, ay, az] = meta.gridBounds.min;
        const [bx, by, bz] = meta.gridBounds.max;
        this.voxelBounds = new pc.BoundingBox();
        this.voxelBounds.setMinMax(
            new pc.Vec3(Math.min(-ax, -bx), ay, Math.min(-az, -bz)),
            new pc.Vec3(Math.max(-ax, -bx), by, Math.max(-az, -bz))
        );

        if (!this.splatEntity && !this.collisionEntity) this.frame();
        return { count, truncated, applied: true };
    }

    clearVoxels(): void {
        this.voxelSeq++; // invalidate any in-flight loadVoxels
        this.voxelEntity?.render?.meshInstances[0]?.setInstancing(null);
        this.voxelEntity?.destroy();
        this.voxelEntity = null;
        this.voxelVb?.destroy();
        this.voxelVb = null;
        this.voxelMesh?.destroy();
        this.voxelMesh = null;
        this.voxelBounds = null;
    }

    /** Unload every layer and empty the viewport. */
    clearAll(): void {
        this.clearSplat();
        this.clearCollision();
        this.clearVoxels();
    }

    /** Apply an equirectangular image (e.g. a panorama .webp/.jpg/.hdr) as the scene skybox. */
    async setSkybox(url: string, filename: string): Promise<boolean> {
        const seq = ++this.skyboxSeq;
        const asset = await this.loadAsset(url, filename, 'texture');
        if (seq !== this.skyboxSeq) { this.app.assets.remove(asset); asset.unload(); return false; }
        const src = asset.resource as pc.Texture;
        src.projection = pc.TEXTUREPROJECTION_EQUIRECT;
        const cubemap = pc.EnvLighting.generateSkyboxCubemap(src);
        this.skyboxCubemap?.destroy();
        this.skyboxCubemap = cubemap;
        this.app.scene.skybox = cubemap;
        this.app.scene.skyboxMip = 0; // use the sharp cubemap directly
        this.skyboxAsset?.unload();
        this.skyboxAsset = asset;
        return true;
    }

    clearSkybox(): void {
        this.skyboxSeq++;
        this.app.scene.skybox = null;
        this.skyboxCubemap?.destroy();
        this.skyboxCubemap = null;
        if (this.skyboxAsset) { this.app.assets.remove(this.skyboxAsset); this.skyboxAsset.unload(); this.skyboxAsset = null; }
    }

    get hasSkybox(): boolean { return this.skyboxCubemap !== null; }

    get hasVoxels(): boolean { return this.voxelEntity !== null; }

    setVoxelsVisible(visible: boolean): void {
        if (this.voxelEntity) this.voxelEntity.enabled = visible;
    }

    setVoxelColor(hex: string): void {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        this.voxelMaterial.emissive = new pc.Color(r, g, b);
        this.voxelMaterial.update();
    }

    setVoxelOpacity(opacity: number): void {
        this.voxelMaterial.opacity = opacity;
        this.voxelMaterial.update();
    }

    // ----- bounding-box overlay -----
    // The splat lives under sceneRoot's 180° X rotation (an axis flip), so its
    // world AABB stays axis-aligned: world min/max = center ± halfExtents.
    private worldSplatAabb(): { min: pc.Vec3; max: pc.Vec3 } | null {
        const aabb = this.splatEntity?.gsplat?.customAabb;
        if (!aabb || !this.splatEntity) return null;
        const c = this.splatEntity.getWorldTransform().transformPoint(aabb.center);
        const he = aabb.halfExtents;
        return {
            min: new pc.Vec3(c.x - he.x, c.y - he.y, c.z - he.z),
            max: new pc.Vec3(c.x + he.x, c.y + he.y, c.z + he.z)
        };
    }

    setBoundsVisible(visible: boolean): void {
        this.boundsVisible = visible;
        if (visible) this.refreshBounds();
        else if (this.boundsEntity) this.boundsEntity.enabled = false;
    }

    /** Redraw the box from the current splat's world AABB (no-op while hidden). */
    refreshBounds(): void {
        if (!this.boundsVisible) return;
        const b = this.worldSplatAabb();
        if (!b) { if (this.boundsEntity) this.boundsEntity.enabled = false; return; }
        if (!this.boundsEntity) {
            const mesh = pc.Mesh.fromGeometry(this.app.graphicsDevice, new pc.BoxGeometry());
            const mi = new pc.MeshInstance(mesh, this.boundsMaterial);
            mi.renderStyle = pc.RENDERSTYLE_WIREFRAME;
            this.boundsEntity = new pc.Entity('bounds');
            this.boundsEntity.addComponent('render', { meshInstances: [mi], layers: [pc.LAYERID_IMMEDIATE] });
            this.app.root.addChild(this.boundsEntity);
        }
        this.boundsEntity.enabled = true;
        this.boundsEntity.setLocalScale(
            Math.max(b.max.x - b.min.x, 1e-4),
            Math.max(b.max.y - b.min.y, 1e-4),
            Math.max(b.max.z - b.min.z, 1e-4)
        );
        this.boundsEntity.setLocalPosition(
            (b.min.x + b.max.x) / 2,
            (b.min.y + b.max.y) / 2,
            (b.min.z + b.max.z) / 2
        );
    }

    clearSplat(): void {
        this.splatSeq++; // invalidate any in-flight loadSplat
        this.splatEntity?.destroy();
        this.splatEntity = null;
        this.pickCenters = null;
        this.occCenters = null;
        if (this.boundsEntity) this.boundsEntity.enabled = false;
        if (this.splatAsset) {
            this.app.assets.remove(this.splatAsset);
            this.splatAsset.unload();
            this.splatAsset = null;
        }
    }

    clearCollision(): void {
        this.collisionSeq++; // invalidate any in-flight loadCollision
        this.collisionSurfMIs = [];
        this.collisionTriangles = 0;
        this.collisionEntity?.destroy();
        this.collisionEntity = null;
        if (this.collisionAsset) {
            this.app.assets.remove(this.collisionAsset);
            this.collisionAsset.unload();
            this.collisionAsset = null;
        }
    }

    get hasSplat(): boolean { return this.splatEntity !== null; }
    get hasCollision(): boolean { return this.collisionEntity !== null; }

    setSplatVisible(visible: boolean): void {
        if (this.splatEntity) this.splatEntity.enabled = visible;
    }

    setCollisionVisible(visible: boolean): void {
        this.collisionHolder.enabled = visible;
    }

    setWireColor(hex: string): void {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        this.wireMaterial.emissive = new pc.Color(r, g, b);
        this.wireMaterial.update();
    }

    setWireOpacity(opacity: number): void {
        this.wireMaterial.opacity = opacity;
        this.wireMaterial.update();
    }

    /**
     * Default (false) orients for splat-transform output (180° Y). Flipped
     * removes that for meshes already authored in viewer/engine space.
     */
    setCollisionFlipped(flipped: boolean): void {
        this.collisionHolder.setLocalEulerAngles(0, flipped ? 0 : 180, 0);
    }

    /** Place the seed (marker + capsule + gizmo). x,y,z are splat-transform (CLI) coords, as typed. */
    setSeed(x: number, y: number, z: number): void {
        this.seedNode.setLocalPosition(x, y, z);
    }

    /** Rebuild the carve-capsule preview, centered on the seed (height = tip to tip, meters). */
    setCapsule(height: number, radius: number): void {
        const r = Math.max(radius, 0.001);
        const h = Math.max(height, 2 * r); // a capsule can't be shorter than its two caps
        const mesh = pc.Mesh.fromGeometry(this.app.graphicsDevice, new pc.CapsuleGeometry({ radius: r, height: h, sides: 16 }));
        (this.capsuleEntity.render as pc.RenderComponent).meshInstances = [new pc.MeshInstance(mesh, this.capsuleMaterial)];
        this.capsuleMesh?.destroy();
        this.capsuleMesh = mesh;
    }

    // seed marker + carve capsule visibility is driven by hierarchy selection
    // ('capsule') via applySelection — not a standalone toggle.

    // ----- edit tools: measure → scale, and set-origin -----
    private attachGizmo(target: 'seed' | 'a' | 'b'): void {
        this.gizmoTarget = target;
        this.gizmo.attach(target === 'seed' ? this.seedNode : target === 'a' ? this.mA : this.mB);
    }

    /** Cache the splat's gaussian centres (entity-local) for click-picking + occlusion. */
    private buildCenterCaches(asset: pc.Asset): void {
        const res = asset.resource as unknown as { _centers?: Float32Array };
        const centers = res?._centers ?? null;
        this.pickCenters = centers;
        if (!centers) { this.occCenters = null; return; }
        const n = centers.length / 3;
        const target = 40000; // downsample for cheap per-frame occlusion tests
        const stride = Math.max(1, Math.floor(n / target));
        if (stride === 1) { this.occCenters = centers; return; }
        const occ = new Float32Array(Math.ceil(n / stride) * 3);
        let w = 0;
        for (let i = 0; i < n; i += stride) { const j = i * 3; occ[w++] = centers[j]; occ[w++] = centers[j + 1]; occ[w++] = centers[j + 2]; }
        this.occCenters = occ.subarray(0, w);
    }

    /**
     * Click-to-place: on a non-drag left click in an edit mode, ray-pick the
     * front splat surface and drop the active marker there.
     */
    private installClickToPlace(canvas: HTMLCanvasElement): void {
        let downX = 0, downY = 0, downT = 0, btn = 0;
        canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; downT = e.timeStamp; btn = e.button; });
        canvas.addEventListener('pointerup', (e) => {
            if (this.editMode === 'none' || btn !== 0 || e.button !== 0) return;
            const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
            if (moved > 5 || e.timeStamp - downT > 600) return; // a drag/hold = camera orbit, not a placement
            const rect = canvas.getBoundingClientRect();
            const hit = this.pickSurfacePoint(e.clientX - rect.left, e.clientY - rect.top);
            if (hit) this.placeActiveMarker(hit);
        });
    }

    /**
     * Cast a ray through the clicked pixel and return the front-most splat
     * surface point (world space), or null over empty space. Works against the
     * raw gaussian centres — no collision mesh required.
     */
    pickSurfacePoint(px: number, py: number): pc.Vec3 | null {
        const centers = this.pickCenters;
        const e = this.splatEntity;
        if (!centers || !e) return null;
        const camC = this.camera.camera as pc.CameraComponent;
        const near = camC.screenToWorld(px, py, camC.nearClip);
        const far = camC.screenToWorld(px, py, camC.farClip);
        if (!Number.isFinite(near.x) || !Number.isFinite(far.x)) return null;
        const dir = far.clone().sub(near).normalize();
        const inv = e.getWorldTransform().clone().invert();
        const o = inv.transformPoint(near.clone());
        const d = inv.transformVector(dir.clone()).normalize();
        const n = centers.length / 3;
        const stride = Math.max(1, Math.floor(n / 600000)); // cap the per-click scan
        const h = (this.app.graphicsDevice.height || 900);
        const coneTan = Math.tan((camC.fov * Math.PI / 180) / h * 6); // ~6px pick radius
        let bestT = Infinity, bx = 0, by = 0, bz = 0;
        const ox = o.x, oy = o.y, oz = o.z, dx = d.x, dy = d.y, dz = d.z;
        for (let i = 0; i < n; i += stride) {
            const j = i * 3;
            const ax = centers[j] - ox, ay = centers[j + 1] - oy, az = centers[j + 2] - oz;
            const t = ax * dx + ay * dy + az * dz;
            if (t <= 0 || t >= bestT) continue;
            const qx = ax - dx * t, qy = ay - dy * t, qz = az - dz * t;
            if (qx * qx + qy * qy + qz * qz <= (coneTan * t) * (coneTan * t)) { bestT = t; bx = centers[j]; by = centers[j + 1]; bz = centers[j + 2]; }
        }
        if (bestT === Infinity) return null;
        return e.getWorldTransform().transformPoint(new pc.Vec3(bx, by, bz));
    }

    /** True if the splat surface sits between the camera and this world point. */
    private isMarkerOccluded(world: pc.Vec3): boolean {
        const occ = this.occCenters;
        const e = this.splatEntity;
        if (!occ || !e) return false;
        const inv = e.getWorldTransform().clone().invert();
        const m = inv.transformPoint(world.clone());
        const c = inv.transformPoint(this.camera.getPosition().clone());
        let dx = m.x - c.x, dy = m.y - c.y, dz = m.z - c.z;
        const tM = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (tM < 1e-4) return false;
        dx /= tM; dy /= tM; dz /= tM;
        const camC = this.camera.camera as pc.CameraComponent;
        const h = (this.app.graphicsDevice.height || 900);
        const coneTan = Math.tan((camC.fov * Math.PI / 180) / h * 5);
        const near = tM * 0.04, farT = tM * 0.9;
        let cnt = 0;
        for (let k = 0; k < occ.length; k += 3) {
            const ax = occ[k] - c.x, ay = occ[k + 1] - c.y, az = occ[k + 2] - c.z;
            const t = ax * dx + ay * dy + az * dz;
            if (t <= near || t >= farT) continue;
            const qx = ax - dx * t, qy = ay - dy * t, qz = az - dz * t;
            if (qx * qx + qy * qy + qz * qz <= (coneTan * t) * (coneTan * t)) { if (++cnt >= 4) return true; }
        }
        return false;
    }

    /** Drop the active marker at a world point; advance A→B in measure mode. */
    private placeActiveMarker(world: pc.Vec3): void {
        const which = this.editMode === 'origin' ? 'a' : this.activeMarker;
        (which === 'a' ? this.mA : this.mB).setPosition(world);
        this.placed[which] = true;
        if (this.editMode === 'measure') {
            this.activeMarker = which === 'a' ? 'b' : 'a';
            this.onActiveMarkerChange?.(this.activeMarker);
            this.onMeasureChange?.(this.measureDistance());
        }
        this.onEditPlaced?.();
        this.lastCamKey = ''; // force a marker refresh this frame
    }

    /** Per-frame: keep markers a constant on-screen size and hide occluded ones. */
    private updateEditMarkers(): void {
        const camPos = this.camera.getPosition();
        const camC = this.camera.camera as pc.CameraComponent;
        const h = this.app.graphicsDevice.height || 900;
        const sizeK = 2 * Math.tan((camC.fov * Math.PI / 180) / 2) / h * 5; // ~5px radius
        const key = `${camPos.x.toFixed(2)},${camPos.y.toFixed(2)},${camPos.z.toFixed(2)}`;
        const recompute = key !== this.lastCamKey;
        this.lastCamKey = key;
        const apply = (e: pc.Entity, on: boolean): boolean => {
            if (!on) { e.enabled = false; return false; }
            if (recompute) {
                const dist = e.getPosition().distance(camPos);
                const s = Math.max(dist * sizeK, 1e-3);
                e.setLocalScale(s, s, s);
                e.enabled = !this.isMarkerOccluded(e.getPosition());
            }
            return e.enabled;
        };
        const aVis = apply(this.mA, this.placed.a);
        const bVis = apply(this.mB, this.editMode === 'measure' && this.placed.b);
        if (this.editMode === 'measure' && this.placed.a && this.placed.b && (aVis || bVis)) {
            this.drawLine3(this.mA.getPosition(), this.mB.getPosition(), new pc.Color(1, 1, 0.35));
        }
    }

    /** 'measure' places two markers; 'origin' one; 'none' restores the selection gizmo. */
    setEditMode(mode: 'none' | 'measure' | 'origin'): void {
        this.editMode = mode;
        this.placed = { a: false, b: false };
        this.activeMarker = 'a';
        this.mA.enabled = false;
        this.mB.enabled = false;
        this.lastCamKey = '';
        this.applySelection(); // measure/origin suppress the gizmo; 'none' restores it
    }

    /** Choose which marker the next click sets (measure mode only). */
    setActiveMarker(which: 'a' | 'b'): void {
        if (this.editMode === 'measure') this.activeMarker = which;
    }

    /** Distance between the two markers, in world units (= real splat units). */
    measureDistance(): number {
        if (!this.placed.a || !this.placed.b) return 0;
        return this.mA.getPosition().distance(this.mB.getPosition());
    }

    /**
     * The --translate vector that makes marker A the splat's origin. The splat
     * renders under sceneRoot's R_x(180), so raw = (x, -y, -z) of the world point,
     * and the translate is its negation.
     */
    originTranslateCli(): { x: number; y: number; z: number } {
        const m = this.mA.getPosition();
        return { x: round(-m.x), y: round(m.y), z: round(m.z) };
    }

    /** Whether the required markers for the active edit mode have been placed. */
    get markersPlaced(): boolean {
        return this.editMode === 'origin' ? this.placed.a : this.placed.a && this.placed.b;
    }

    /**
     * Current camera position converted to splat-transform's voxel space for
     * --seed-pos: that space is R_y(180) of viewer world space, so x and z negate.
     */
    cameraSeedPos(): { x: number; y: number; z: number } {
        const p = this.camera.getPosition();
        return { x: round(-p.x), y: round(p.y), z: round(-p.z) };
    }

    /**
     * Camera pose for the WebP renderer's --camera/--look-at, as "x,y,z" strings.
     * The splat renders under sceneRoot's 180° X flip, so raw-splat space = viewer
     * space mapped (x, -y, -z); look-at is a point one unit ahead of the camera.
     * A starting point the user can fine-tune.
     */
    cameraRenderPose(): { camera: string; lookAt: string } {
        const p = this.camera.getPosition();
        const f = this.camera.forward;
        const flip = (x: number, y: number, z: number) => `${round(x)},${round(-y)},${round(-z)}`;
        return { camera: flip(p.x, p.y, p.z), lookAt: flip(p.x + f.x, p.y + f.y, p.z + f.z) };
    }

    private drawLine3(a: pc.Vec3, b: pc.Vec3, color: pc.Color): void {
        (this.app as unknown as { drawLine: (a: pc.Vec3, b: pc.Vec3, c: pc.Color, d?: boolean) => void })
            .drawLine(a, b, color, false);
    }

    /**
     * Show/update the WebP render camera as a frustum in the viewport. camera and
     * lookAt are "x,y,z" in CLI render space (raw splat), mapped to viewer space
     * with the sceneRoot R_x(180) flip (x, -y, -z). Pass show=false to hide.
     */
    setRenderFrustum(camera: string, lookAt: string, fov: number, aspect: number, show: boolean): void {
        const parse = (s: string): pc.Vec3 | null => {
            const p = String(s).split(',').map(Number);
            return p.length === 3 && p.every(Number.isFinite) ? new pc.Vec3(p[0], -p[1], -p[2]) : null;
        };
        const c = parse(camera);
        const l = parse(lookAt);
        this.renderFrustum = show && c && l
            ? { camera: c, lookAt: l, fov: Number.isFinite(fov) && fov > 0 ? fov : 60, aspect: aspect > 0 ? aspect : 16 / 9 }
            : null;
        // keep the gizmo's backing node on the camera (unless a drag is in flight)
        if (this.renderFrustum && !this.gizmoDragging) {
            this.renderCamNode.setPosition(this.renderFrustum.camera);
            this.renderCamNode.lookAt(this.renderFrustum.lookAt);
            this.renderCamDist = Math.max(this.renderFrustum.lookAt.clone().sub(this.renderFrustum.camera).length(), 0.5);
        }
        // if the render camera went away (left WebP), drop a stale selection
        if (!this.renderFrustum && this.selected === 'render-camera') this.selectObject('none');
    }

    /** Whether a WebP render camera currently exists (so the hierarchy can list it). */
    get hasRenderCamera(): boolean { return this.renderFrustum !== null; }

    /**
     * Drive a live preview of the WebP render camera into a 2D canvas. A second
     * camera renders only the WORLD layer (splat) — no gizmos/markers/frustum,
     * which all live on the immediate layer — to a small RenderTarget; its pixels
     * are read back (throttled, one read in flight) and drawn into `canvas`.
     */
    setupCameraView(canvas: HTMLCanvasElement, w = 320, h = 180): void {
        this.teardownCameraView();
        const device = this.app.graphicsDevice;
        this.previewTex = new pc.Texture(device, {
            name: 'webp-preview', width: w, height: h, format: pc.PIXELFORMAT_RGBA8, mipmaps: false,
            minFilter: pc.FILTER_LINEAR, magFilter: pc.FILTER_LINEAR,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE, addressV: pc.ADDRESS_CLAMP_TO_EDGE
        });
        this.previewRT = new pc.RenderTarget({ colorBuffer: this.previewTex, depth: true, samples: 1 });
        const cam = new pc.Entity('webp-preview-cam');
        cam.addComponent('camera', {
            clearColor: new pc.Color(0.055, 0.06, 0.07),
            fov: 60,
            layers: [pc.LAYERID_WORLD], // splat only — excludes immediate-layer gizmos/markers/frustum
            renderTarget: this.previewRT
        });
        cam.enabled = false;
        this.app.root.addChild(cam);
        this.previewCam = cam;
        canvas.width = w; canvas.height = h;
        this.previewCtx = canvas.getContext('2d');
        this.previewImg = this.previewCtx ? this.previewCtx.createImageData(w, h) : null;
        this.previewW = w; this.previewH = h;
        this.previewUpdate = () => this.updateCameraView();
        this.app.on('update', this.previewUpdate);
    }

    teardownCameraView(): void {
        if (this.previewUpdate) { this.app.off('update', this.previewUpdate); this.previewUpdate = null; }
        this.previewCam?.destroy();
        this.previewRT?.destroy();
        this.previewTex?.destroy();
        this.previewCam = null; this.previewRT = null; this.previewTex = null;
        this.previewCtx = null; this.previewImg = null; this.previewReading = false;
    }

    private updateCameraView(): void {
        const rf = this.renderFrustum, cam = this.previewCam, rt = this.previewRT, tex = this.previewTex;
        const w = this.previewW, h = this.previewH;
        if (!rf || !cam || !rt || !tex || !this.previewCtx || !this.previewImg) { if (cam) cam.enabled = false; return; }
        cam.enabled = true;
        cam.setPosition(rf.camera);
        cam.lookAt(rf.lookAt);
        const cc = cam.camera as pc.CameraComponent;
        cc.fov = rf.fov;
        cc.aspectRatio = w / h;
        // throttle the readback: ~15-20fps, never two reads in flight, one reused buffer
        if (this.previewReading || (this.previewFrame++ % 3) !== 0) return;
        this.previewReading = true;
        tex.read(0, 0, w, h, { renderTarget: rt }).then((data) => {
            this.previewReading = false;
            const ctx = this.previewCtx, img = this.previewImg;
            if (!ctx || !img || !data) return;
            const out = img.data, row = w * 4;
            for (let y = 0; y < h; y++) out.set(data.subarray((h - 1 - y) * row, (h - y) * row), y * row); // RT is bottom-up
            ctx.putImageData(img, 0, 0);
        }).catch(() => { this.previewReading = false; });
    }

    private emitRenderCameraFromNode(): void {
        const pos = this.renderCamNode.getPosition();
        const look = pos.clone().add(this.renderCamNode.forward.clone().mulScalar(this.renderCamDist));
        const toCli = (v: pc.Vec3) => ({ x: round(v.x), y: round(-v.y), z: round(-v.z) });
        this.onRenderCameraMove?.(toCli(pos), toCli(look));
    }

    // ----- scene-hierarchy selection + camera control mode -----
    /** Fly = mouse-look + WASD (default); orbit = drag around the focus point. */
    setCameraMode(mode: 'fly' | 'orbit'): void {
        this.controls.enableFly = mode === 'fly';
        this.controls.enableOrbit = mode === 'orbit';
    }

    /** Place the camera at eye looking at target (viewer-world). */
    setCamera(eye: number[], target: number[]): void {
        const e = new pc.Vec3(eye[0], eye[1], eye[2]);
        const t = new pc.Vec3(target[0], target[1], target[2]);
        if (this.controls?.reset) this.controls.reset(t, e);
        else { this.camera.setPosition(e); this.camera.lookAt(t); }
    }

    /** Current camera pose in viewer-world: eye, the look target, fov, mode. */
    getCamera(): { eye: number[]; target: number[]; fov: number; mode: 'fly' | 'orbit' } {
        const pos = this.camera.getPosition();
        const b = this.sceneBounds();
        const dist = b ? Math.max(pos.distance(b.center), 0.5) : 5;
        const tgt = pos.clone().add(this.camera.forward.clone().mulScalar(dist));
        return {
            eye: [round(pos.x), round(pos.y), round(pos.z)],
            target: [round(tgt.x), round(tgt.y), round(tgt.z)],
            fov: (this.camera.camera as pc.CameraComponent).fov,
            mode: this.controls?.enableOrbit ? 'orbit' : 'fly'
        };
    }

    /** One-shot PNG of the main camera (base64, no data: prefix) via an offscreen RT. */
    async captureScreenshot(): Promise<{ png: string; width: number; height: number }> {
        const device = this.app.graphicsDevice;
        const w = Math.min(device.width || 1280, 1920);
        const h = Math.min(device.height || 720, 1080);
        // allocate inside the try so a throw mid-setup still hits the cleanup path
        let tex: pc.Texture | null = null, rt: pc.RenderTarget | null = null, cam: pc.Entity | null = null;
        try {
            tex = new pc.Texture(device, { name: 'mcp-shot', width: w, height: h, format: pc.PIXELFORMAT_RGBA8, mipmaps: false });
            rt = new pc.RenderTarget({ colorBuffer: tex, depth: true, samples: 1 });
            const src = this.camera.camera as pc.CameraComponent;
            cam = new pc.Entity('mcp-shot-cam');
            cam.addComponent('camera', { clearColor: src.clearColor, fov: src.fov, layers: src.layers.slice(), renderTarget: rt });
            cam.setPosition(this.camera.getPosition());
            cam.setRotation(this.camera.getRotation());
            (cam.camera as pc.CameraComponent).aspectRatio = w / h;
            this.app.root.addChild(cam);
            this.app.render();
            const data = await tex.read(0, 0, w, h, { renderTarget: rt });
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx || !data) throw new Error('screenshot readback failed');
            const img = ctx.createImageData(w, h);
            const row = w * 4;
            for (let y = 0; y < h; y++) img.data.set(data.subarray((h - 1 - y) * row, (h - y) * row), y * row); // RT is bottom-up
            ctx.putImageData(img, 0, 0);
            return { png: canvas.toDataURL('image/png').split(',')[1], width: w, height: h };
        } finally {
            cam?.destroy(); rt?.destroy(); tex?.destroy();
        }
    }

    /** Select a scene object — shows its gizmo (capsule/render-camera) or nothing. */
    selectObject(id: SelId): void {
        this.selected = id;
        this.applySelection();
        this.onSelectionChange?.(id);
    }

    /** Render-camera gizmo sub-mode: translate ('move') or rotate. */
    setCameraGizmoMode(mode: 'move' | 'rotate'): void {
        this.camGizmoMode = mode;
        if (this.selected === 'render-camera') this.applySelection();
    }

    get selection(): SelId { return this.selected; }

    /** The WebGPU canvas (for viewport-coordinate picks from the MCP bridge). */
    get canvas(): HTMLCanvasElement { return this.app.graphicsDevice.canvas as HTMLCanvasElement; }

    private applySelection(): void {
        const sel = this.selected;
        // the carve capsule + seed marker exist only while selected
        const capsuleSel = sel === 'capsule';
        this.seedMarker.enabled = capsuleSel;
        this.capsuleEntity.enabled = capsuleSel;
        // exactly one gizmo at a time — detach all, then attach for the selection
        this.gizmo.detach();
        this.rotGizmo.detach();
        this.regionGizmo.detach();
        // measure/origin and crop tools own the viewport; no selection gizmo then
        if (this.editMode !== 'none' || this.cropMode !== 'none') return;
        if (sel === 'collision-region') {
            // Move mode → translate gizmo; Resize mode → per-face handles (updateRegionHandles)
            if (this.regionBoxNode.enabled && this.regionGizmoMode === 'move') this.regionGizmo.attach(this.regionBoxNode);
        } else if (capsuleSel) {
            this.gizmoTarget = 'seed';
            this.gizmo.attach(this.seedNode);
        } else if (sel === 'render-camera' && this.renderFrustum) {
            this.renderCamNode.setPosition(this.renderFrustum.camera);
            this.renderCamNode.lookAt(this.renderFrustum.lookAt);
            if (this.camGizmoMode === 'rotate') {
                this.rotGizmo.attach(this.renderCamNode);
            } else {
                this.gizmoTarget = 'camera';
                this.gizmo.attach(this.renderCamNode);
            }
        }
    }

    private drawRenderFrustum(): void {
        const rf = this.renderFrustum;
        if (!rf) return;
        const C = rf.camera;
        const fwd = rf.lookAt.clone().sub(C);
        const dist = Math.max(fwd.length(), 0.5);
        fwd.normalize();
        let right = new pc.Vec3().cross(fwd, pc.Vec3.UP);
        if (right.length() < 1e-4) right = new pc.Vec3(1, 0, 0);
        right.normalize();
        const up = new pc.Vec3().cross(right, fwd).normalize();
        const halfH = dist * Math.tan((rf.fov * Math.PI / 180) / 2);
        const halfW = halfH * rf.aspect;
        const center = C.clone().add(fwd.clone().mulScalar(dist));
        const corner = (sx: number, sy: number): pc.Vec3 =>
            center.clone().add(right.clone().mulScalar(sx * halfW)).add(up.clone().mulScalar(sy * halfH));
        const tl = corner(-1, 1), tr = corner(1, 1), br = corner(1, -1), bl = corner(-1, -1);
        const col = new pc.Color(1, 0.62, 0.25);
        for (const cn of [tl, tr, br, bl]) this.drawLine3(C, cn, col); // edges from the eye
        this.drawLine3(tl, tr, col); this.drawLine3(tr, br, col);      // far rectangle
        this.drawLine3(br, bl, col); this.drawLine3(bl, tl, col);
        this.drawLine3(C, rf.lookAt, new pc.Color(1, 0.85, 0.3));      // optical axis to the target
    }

    /**
     * Live preview of the Convert transform on the displayed splat. translate/
     * rotate/scale are in splat-transform (CLI) action space — which is exactly
     * the splat entity's local space — so the preview matches the baked result.
     * Composition follows the CLI order -t -r -s: localPosition = scale·R·translate.
     * Pass translate=null to clear the preview.
     */
    setSplatPreviewTransform(translate: [number, number, number] | null, rotate: [number, number, number], scale: number): void {
        this.previewXform = translate
            ? { t: new pc.Vec3(translate[0], translate[1], translate[2]), r: new pc.Vec3(rotate[0], rotate[1], rotate[2]), s: scale }
            : null;
        this.applyPreviewXform();
    }

    private applyPreviewXform(): void {
        const e = this.splatEntity;
        if (!e) return;
        const x = this.previewXform;
        if (!x) {
            e.setLocalPosition(0, 0, 0);
            e.setLocalEulerAngles(0, 0, 0);
            e.setLocalScale(1, 1, 1);
            return;
        }
        const s = Number.isFinite(x.s) && x.s > 0 ? x.s : 1;
        const q = new pc.Quat().setFromEulerAngles(x.r.x, x.r.y, x.r.z);
        const pos = q.transformVector(x.t).mulScalar(s);
        e.setLocalPosition(pos);
        e.setLocalEulerAngles(x.r.x, x.r.y, x.r.z);
        e.setLocalScale(s, s, s);
    }

    /** Splat AABB in sceneRoot/cropHolder-local space with the preview transform baked in (or null). */
    private splatOutputBounds(): pc.BoundingBox | null {
        const e = this.splatEntity;
        const aabb = e?.gsplat?.customAabb;
        if (!e || !aabb) return null;
        const out = new pc.BoundingBox();
        out.setFromTransformedAabb(aabb, e.getLocalTransform());
        return out;
    }

    /** Box wireframe from min/max corners (CLI coords); null entries fall back to the splat bounds. */
    setCropBox(min: (number | null)[], max: (number | null)[], show: boolean): void {
        this.cropBoxNode.enabled = show;
        if (show) {
            const b = this.splatOutputBounds();
            const lo = b ? b.getMin() : new pc.Vec3(-10, -10, -10);
            const hi = b ? b.getMax() : new pc.Vec3(10, 10, 10);
            const x0 = min[0] ?? lo.x, y0 = min[1] ?? lo.y, z0 = min[2] ?? lo.z;
            const x1 = max[0] ?? hi.x, y1 = max[1] ?? hi.y, z1 = max[2] ?? hi.z;
            this.cropBoxNode.setLocalPosition((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
            this.cropBoxNode.setLocalScale(Math.max(Math.abs(x1 - x0), 1e-3), Math.max(Math.abs(y1 - y0), 1e-3), Math.max(Math.abs(z1 - z0), 1e-3));
        }
        this.refreshCropGizmo();
    }

    /** Sphere wireframe at centre + radius (CLI coords). */
    setCropSphere(centre: [number, number, number], radius: number, show: boolean): void {
        this.cropSphereNode.enabled = show;
        if (show) {
            this.cropSphereNode.setLocalPosition(centre[0], centre[1], centre[2]);
            const r = Math.max(radius, 1e-3);
            this.cropSphereNode.setLocalScale(r, r, r);
        }
        this.refreshCropGizmo();
    }

    private refreshCropGizmo(): void {
        this.cropMode = this.cropBoxNode.enabled ? 'box' : this.cropSphereNode.enabled ? 'sphere' : 'none';
        if (this.cropMode === 'box') { this.cropGizmo.attach(this.cropBoxNode); this.gizmo.detach(); this.rotGizmo.detach(); }
        else if (this.cropMode === 'sphere') { this.cropGizmo.attach(this.cropSphereNode); this.gizmo.detach(); this.rotGizmo.detach(); }
        else { this.cropGizmo.detach(); this.applySelection(); } // crop cleared → restore selection gizmo
    }

    /** Region box wireframe from min/max corners (CLI coords); null entries fall back to the splat bounds. */
    setCollisionRegion(min: (number | null)[], max: (number | null)[], show: boolean): void {
        this.regionBoxNode.enabled = show;
        if (show) {
            const b = this.splatOutputBounds();
            const lo = b ? b.getMin() : new pc.Vec3(-10, -10, -10);
            const hi = b ? b.getMax() : new pc.Vec3(10, 10, 10);
            const x0 = min[0] ?? lo.x, y0 = min[1] ?? lo.y, z0 = min[2] ?? lo.z;
            const x1 = max[0] ?? hi.x, y1 = max[1] ?? hi.y, z1 = max[2] ?? hi.z;
            this.regionBoxNode.setLocalPosition((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
            this.regionBoxNode.setLocalScale(Math.max(Math.abs(x1 - x0), 1e-3), Math.max(Math.abs(y1 - y0), 1e-3), Math.max(Math.abs(z1 - z0), 1e-3));
        }
        this.applySelection(); // attach/detach the region gizmo to match enabled + selection
    }

    /** Total gaussians in the loaded splat (0 if none). */
    get splatGaussianCount(): number { return this.pickCenters ? this.pickCenters.length / 3 : 0; }

    /** Count splat centres inside the current region box (cheap O(n); 0 if no box). */
    regionGaussianCount(): number {
        const centers = this.pickCenters, e = this.splatEntity;
        if (!centers || !e || !this.regionBoxNode.enabled) return 0;
        const d = this.cropHolder.getWorldTransform().clone().invert().mul(e.getWorldTransform()).data;
        const c = this.regionBoxNode.getLocalPosition(), s = this.regionBoxNode.getLocalScale();
        const minx = c.x - s.x / 2, maxx = c.x + s.x / 2, miny = c.y - s.y / 2, maxy = c.y + s.y / 2, minz = c.z - s.z / 2, maxz = c.z + s.z / 2;
        const n = centers.length / 3;
        let cnt = 0;
        for (let i = 0; i < n; i++) {
            const j = i * 3, X = centers[j], Y = centers[j + 1], Z = centers[j + 2];
            const px = d[0] * X + d[4] * Y + d[8] * Z + d[12];
            const py = d[1] * X + d[5] * Y + d[9] * Z + d[13];
            const pz = d[2] * X + d[6] * Y + d[10] * Z + d[14];
            if (px >= minx && px <= maxx && py >= miny && py <= maxy && pz >= minz && pz <= maxz) cnt++;
        }
        return cnt;
    }

    /** Count splat centres inside the active crop box/sphere — what "Carve out" would remove (0 if none shown). */
    trimInsideCount(): number {
        const centers = this.pickCenters, e = this.splatEntity;
        const boxOn = this.cropBoxNode.enabled, sphOn = this.cropSphereNode.enabled;
        if (!centers || !e || (!boxOn && !sphOn)) return 0;
        const d = this.cropHolder.getWorldTransform().clone().invert().mul(e.getWorldTransform()).data;
        let bminx = 0, bmaxx = 0, bminy = 0, bmaxy = 0, bminz = 0, bmaxz = 0;
        if (boxOn) {
            const c = this.cropBoxNode.getLocalPosition(), s = this.cropBoxNode.getLocalScale();
            bminx = c.x - s.x / 2; bmaxx = c.x + s.x / 2; bminy = c.y - s.y / 2; bmaxy = c.y + s.y / 2; bminz = c.z - s.z / 2; bmaxz = c.z + s.z / 2;
        }
        let scx = 0, scy = 0, scz = 0, sr2 = 0;
        if (sphOn) {
            const c = this.cropSphereNode.getLocalPosition(), s = this.cropSphereNode.getLocalScale();
            scx = c.x; scy = c.y; scz = c.z; sr2 = s.x * s.x; // unit sphere scaled uniformly to r
        }
        const n = centers.length / 3;
        let cnt = 0;
        for (let i = 0; i < n; i++) {
            const j = i * 3, X = centers[j], Y = centers[j + 1], Z = centers[j + 2];
            const px = d[0] * X + d[4] * Y + d[8] * Z + d[12];
            const py = d[1] * X + d[5] * Y + d[9] * Z + d[13];
            const pz = d[2] * X + d[6] * Y + d[10] * Z + d[14];
            const inBox = boxOn && px >= bminx && px <= bmaxx && py >= bminy && py <= bmaxy && pz >= bminz && pz <= bmaxz;
            const inSph = sphOn && ((px - scx) ** 2 + (py - scy) ** 2 + (pz - scz) ** 2) <= sr2;
            if (inBox || inSph) cnt++;
        }
        return cnt;
    }

    /** Splat AABB as [min,max] corners in CLI coords, for seeding a default region (or null). */
    regionDefaultBounds(): { min: [number, number, number]; max: [number, number, number] } | null {
        const b = this.splatOutputBounds();
        if (!b) return null;
        const lo = b.getMin(), hi = b.getMax();
        return { min: [round(lo.x), round(lo.y), round(lo.z)], max: [round(hi.x), round(hi.y), round(hi.z)] };
    }

    /** Read the region box back as absolute min/max corners (CLI coords) during a gizmo drag. */
    private emitRegionBox(): void {
        const p = this.regionBoxNode.getLocalPosition();
        const s = this.regionBoxNode.getLocalScale();
        const hx = Math.abs(s.x) / 2, hy = Math.abs(s.y) / 2, hz = Math.abs(s.z) / 2;
        this.onRegionBoxChange?.(
            { x: round(p.x - hx), y: round(p.y - hy), z: round(p.z - hz) },
            { x: round(p.x + hx), y: round(p.y + hy), z: round(p.z + hz) }
        );
    }

    /** Move (translate gizmo) vs Resize (per-face handles). */
    setRegionGizmoMode(mode: 'move' | 'resize'): void {
        this.regionGizmoMode = mode;
        if (this.selected === 'collision-region') this.applySelection();
    }

    /** Position/size the six face handles each frame; shown only while resizing the selected region. */
    private updateRegionHandles(): void {
        const active = this.selected === 'collision-region' && this.regionGizmoMode === 'resize' && this.regionBoxNode.enabled;
        const c = this.regionBoxNode.getLocalPosition();
        const s = this.regionBoxNode.getLocalScale();
        const half = [s.x / 2, s.y / 2, s.z / 2];
        const camPos = this.camera.getPosition();
        const wt = this.cropHolder.getWorldTransform();
        for (const h of this.regionHandles) {
            h.entity.enabled = active;
            if (!active) continue;
            const lp = new pc.Vec3(c.x, c.y, c.z);
            if (h.axis === 0) lp.x = c.x + h.sign * half[0];
            else if (h.axis === 1) lp.y = c.y + h.sign * half[1];
            else lp.z = c.z + h.sign * half[2];
            h.entity.setLocalPosition(lp);
            const dist = wt.transformPoint(lp.clone()).distance(camPos);
            h.entity.setLocalScale(Math.max(dist * 0.025, 1e-3), Math.max(dist * 0.025, 1e-3), Math.max(dist * 0.025, 1e-3));
        }
    }

    private installRegionHandleDrag(canvas: HTMLCanvasElement): void {
        const camC = () => this.camera.camera as pc.CameraComponent;
        const canDrag = () => this.selected === 'collision-region' && this.regionGizmoMode === 'resize' && this.regionBoxNode.enabled;
        const pick = (px: number, py: number): { axis: 0 | 1 | 2; sign: 1 | -1 } | null => {
            let best: { axis: 0 | 1 | 2; sign: 1 | -1 } | null = null, bestD = 18; // px
            for (const h of this.regionHandles) {
                const wp = this.cropHolder.getWorldTransform().transformPoint(h.entity.getLocalPosition().clone());
                const sp = camC().worldToScreen(wp);
                if (!Number.isFinite(sp.x)) continue;
                const d = Math.hypot(sp.x - px, sp.y - py);
                if (d < bestD) { bestD = d; best = { axis: h.axis, sign: h.sign }; }
            }
            return best;
        };
        canvas.addEventListener('pointerdown', (e) => {
            if (!canDrag() || e.button !== 0) return;
            const rect = canvas.getBoundingClientRect();
            const hit = pick(e.clientX - rect.left, e.clientY - rect.top);
            if (!hit) return;
            this.regionDrag = hit;
            this.controls.enabled = false;
            e.stopPropagation();
        }, true);
        canvas.addEventListener('pointermove', (e) => {
            if (!this.regionDrag) return;
            const rect = canvas.getBoundingClientRect();
            this.dragRegionFace(e.clientX - rect.left, e.clientY - rect.top);
        });
        const end = () => {
            if (!this.regionDrag) return;
            this.regionDrag = null;
            this.controls.enabled = true;
            this.onRegionBoxEnd?.();
        };
        canvas.addEventListener('pointerup', end);
        canvas.addEventListener('pointercancel', end);
    }

    /** Project the pointer onto the dragged face's axis and move that face, opposite pinned. */
    private dragRegionFace(px: number, py: number): void {
        const drag = this.regionDrag;
        if (!drag) return;
        const camC = this.camera.camera as pc.CameraComponent;
        const near = camC.screenToWorld(px, py, camC.nearClip);
        const far = camC.screenToWorld(px, py, camC.farClip);
        if (!Number.isFinite(near.x) || !Number.isFinite(far.x)) return;
        const R0 = near, D = far.clone().sub(near).normalize();
        const wt = this.cropHolder.getWorldTransform();
        const center = this.regionBoxNode.getLocalPosition().clone();
        const scale = this.regionBoxNode.getLocalScale().clone();
        const centerWorld = wt.transformPoint(center.clone());
        const unit = new pc.Vec3(drag.axis === 0 ? 1 : 0, drag.axis === 1 ? 1 : 0, drag.axis === 2 ? 1 : 0);
        const A = wt.transformVector(unit).normalize();
        // closest approach between the axis line (centerWorld, A) and the camera ray (R0, D)
        const w0 = centerWorld.clone().sub(R0);
        const b = A.dot(D), denom = 1 - b * b;
        if (Math.abs(denom) < 1e-3) return; // face edge-on to the view — skip this frame
        const sc = (b * D.dot(w0) - A.dot(w0)) / denom; // signed world units along A from centre
        const k = drag.axis;
        const cArr = [center.x, center.y, center.z], sArr = [scale.x, scale.y, scale.z];
        let lo = cArr[k] - sArr[k] / 2, hi = cArr[k] + sArr[k] / 2;
        const face = cArr[k] + sc;
        if (drag.sign > 0) hi = Math.max(face, lo + 1e-3);
        else lo = Math.min(face, hi - 1e-3);
        const nc = (lo + hi) / 2, ns = Math.max(hi - lo, 1e-3);
        if (k === 0) { center.x = nc; scale.x = ns; }
        else if (k === 1) { center.y = nc; scale.y = ns; }
        else { center.z = nc; scale.z = ns; }
        this.regionBoxNode.setLocalPosition(center);
        this.regionBoxNode.setLocalScale(scale);
        this.emitRegionBox();
    }

    frame(): void {
        const bounds = this.sceneBounds();
        if (!bounds) return;
        const { center, radius } = bounds;
        const size = Math.max(radius, 0.5);
        (this.camera.camera as pc.CameraComponent).farClip = Math.max(1000, size * 20);
        const eye = new pc.Vec3(center.x + size * 1.2, center.y + size * 0.7, center.z + size * 1.2);
        if (this.controls?.reset) {
            this.controls.reset(center, eye);
        } else {
            this.camera.setPosition(eye);
            this.camera.lookAt(center);
        }
    }

    private sceneBounds(): { center: pc.Vec3; radius: number } | null {
        const splatAabb = this.splatEntity?.gsplat?.customAabb;
        if (splatAabb && this.splatEntity) {
            const center = this.splatEntity.getWorldTransform().transformPoint(splatAabb.center);
            return { center, radius: splatAabb.halfExtents.length() };
        }
        if (this.collisionEntity) {
            const aabb = new pc.BoundingBox();
            let first = true;
            for (const component of this.collisionEntity.findComponents('render') as pc.RenderComponent[]) {
                for (const mi of component.meshInstances) {
                    if (first) { aabb.copy(mi.aabb); first = false; } else aabb.add(mi.aabb);
                }
            }
            if (!first) return { center: aabb.center.clone(), radius: aabb.halfExtents.length() };
        }
        if (this.voxelBounds) {
            return { center: this.voxelBounds.center.clone(), radius: this.voxelBounds.halfExtents.length() };
        }
        return null;
    }
}

const round = (v: number) => Math.round(v * 100) / 100;
