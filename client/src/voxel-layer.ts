// Voxel-octree overlay layer: loads a .voxel.json + sibling .voxel.bin pair
// and renders it as hardware-instanced translucent boxes in viewer space.
import * as pc from 'playcanvas';
import { hexColor } from './line-meshes';
import { makeVoxelMaterial } from './viewer-materials';
import { parseVoxelOctree } from './voxel-parser';
import type { VoxelMeta } from './voxel-parser';

/** SplatViewer's voxel layer: load/clear with stale-load guarding, visibility and styling. */
export class VoxelLayer {
    private entity: pc.Entity | null = null;
    private box: pc.BoundingBox | null = null;
    private mesh: pc.Mesh | null = null;
    private vb: pc.VertexBuffer | null = null;
    private material = makeVoxelMaterial();
    private seq = 0;

    constructor(private app: pc.AppBase) {}

    /**
     * Renders a sparse voxel octree as hardware-instanced translucent boxes.
     * Box transforms are baked from splat-transform's voxel space into viewer
     * space (180° about Y), since per-instance matrices replace the node's
     * world transform.
     * @returns applied=false when superseded by a newer load or a clear.
     */
    async load(url: string): Promise<{ count: number; truncated: boolean; applied: boolean }> {
        this.clear(); // bumps seq, superseding any in-flight load
        const seq = this.seq;

        const meta = (await (await fetch(url)).json()) as VoxelMeta;
        const binUrl = url.replace(/\.voxel\.json$/, '.voxel.bin');
        const bin = await (await fetch(binUrl)).arrayBuffer();
        if (seq !== this.seq) return { count: 0, truncated: false, applied: false };

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
        const mi = new pc.MeshInstance(mesh, this.material);
        const vb = new pc.VertexBuffer(
            device,
            pc.VertexFormat.getDefaultInstancingFormat(device),
            count,
            { data: matrices.buffer }
        );
        mi.setInstancing(vb);
        this.mesh = mesh;
        this.vb = vb;

        const entity = new pc.Entity('voxels');
        entity.addComponent('render', {
            meshInstances: [mi],
            layers: [pc.LAYERID_IMMEDIATE]
        });
        this.app.root.addChild(entity);
        this.entity = entity;

        // bounds in viewer space (x and z negate, so recompute min/max)
        const [ax, ay, az] = meta.gridBounds.min;
        const [bx, by, bz] = meta.gridBounds.max;
        this.box = new pc.BoundingBox();
        this.box.setMinMax(
            new pc.Vec3(Math.min(-ax, -bx), ay, Math.min(-az, -bz)),
            new pc.Vec3(Math.max(-ax, -bx), by, Math.max(-az, -bz))
        );

        return { count, truncated, applied: true };
    }

    clear(): void {
        this.seq++; // invalidate any in-flight load
        this.entity?.render?.meshInstances[0]?.setInstancing(null);
        this.entity?.destroy();
        this.entity = null;
        this.vb?.destroy();
        this.vb = null;
        this.mesh?.destroy();
        this.mesh = null;
        this.box = null;
    }

    get loaded(): boolean { return this.entity !== null; }

    /** Grid bounds in viewer space, or null when nothing is loaded. */
    get bounds(): pc.BoundingBox | null { return this.box; }

    setVisible(visible: boolean): void {
        if (this.entity) this.entity.enabled = visible;
    }

    setColor(hex: string): void {
        this.material.emissive = hexColor(hex);
        this.material.update();
    }

    setOpacity(opacity: number): void {
        this.material.opacity = opacity;
        this.material.update();
    }
}
