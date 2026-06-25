import * as pc from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import { parseVoxelOctree } from './voxel-parser';
import type { VoxelMeta } from './voxel-parser';

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
    private splatSeq = 0;
    private collisionSeq = 0;
    private voxelSeq = 0;

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
                enableFly: true, // WASD — needed to inspect carved interiors from inside
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
        this.gizmo.attach(this.seedNode);
        this.gizmo.on('pointer:down', (_x: number, _y: number, mi: pc.MeshInstance | null) => {
            if (mi) this.controls.enabled = false;
        });
        this.gizmo.on('pointer:up', () => { this.controls.enabled = true; });
        this.gizmo.on('transform:move', () => {
            const p = this.seedNode.getPosition();
            this.onSeedMove?.({ x: round(-p.x), y: round(p.y), z: round(-p.z) });
        });
        this.gizmo.on('transform:end', () => this.onSeedMoveEnd?.());

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

    /** Show/hide the seed marker and its drag gizmo. */
    setSeedMarkerVisible(visible: boolean): void {
        this.seedMarker.enabled = visible;
        if (visible) this.gizmo.attach(this.seedNode);
        else this.gizmo.detach();
    }
    setCapsuleVisible(visible: boolean): void { this.capsuleEntity.enabled = visible; }

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
