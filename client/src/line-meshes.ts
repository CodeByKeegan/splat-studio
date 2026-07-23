// Pure viewer helpers: wireframe unit meshes (box/sphere) plus the small
// numeric kernels SplatViewer shares between drag handles and RT readbacks.
import * as pc from 'playcanvas';

/** 2-decimal rounding for values emitted back into form fields. */
export const round = (v: number): number => Math.round(v * 100) / 100;

/** '#rrggbb' -> pc.Color */
export const hexColor = (hex: string): pc.Color =>
    new pc.Color(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);

/** 12-edge unit line box — no triangle diagonals. */
export const lineBoxMesh = (device: pc.GraphicsDevice): pc.Mesh => {
    const mesh = new pc.Mesh(device);
    const h = 0.5;
    const pos: number[] = [];
    for (const z of [-h, h]) for (const y of [-h, h]) for (const x of [-h, h]) pos.push(x, y, z); // idx = x + 2y + 4z
    mesh.setPositions(pos);
    mesh.setIndices([0, 1, 1, 5, 5, 4, 4, 0, 2, 3, 3, 7, 7, 6, 6, 2, 0, 2, 1, 3, 5, 7, 4, 6]);
    mesh.update(pc.PRIMITIVE_LINES);
    return mesh;
};

/** Three orthogonal unit circles — reads much cleaner over a splat than a triangle wireframe. */
export const lineSphereMesh = (device: pc.GraphicsDevice): pc.Mesh => {
    const mesh = new pc.Mesh(device);
    const SEG = 64;
    const pos: number[] = [];
    const idx: number[] = [];
    let base = 0;
    for (const plane of [0, 1, 2]) {
        for (let i = 0; i < SEG; i++) {
            const a = (i / SEG) * Math.PI * 2;
            const c = Math.cos(a), s = Math.sin(a);
            if (plane === 0) pos.push(0, c, s);
            else if (plane === 1) pos.push(c, 0, s);
            else pos.push(c, s, 0);
            idx.push(base + i, base + ((i + 1) % SEG));
        }
        base += SEG;
    }
    mesh.setPositions(pos);
    mesh.setIndices(idx);
    mesh.update(pc.PRIMITIVE_LINES);
    return mesh;
};

/**
 * Signed distance along axisDir (unit) from axisOrigin to the point on that
 * axis line closest to the camera ray (rayOrigin, unit rayDir), or null when
 * the axis is near-parallel to the ray (edge-on to the view).
 */
export const closestPointOnAxisToRay = (axisOrigin: pc.Vec3, axisDir: pc.Vec3, rayOrigin: pc.Vec3, rayDir: pc.Vec3): number | null => {
    const w0 = axisOrigin.clone().sub(rayOrigin);
    const b = axisDir.dot(rayDir);
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-3) return null;
    return (b * rayDir.dot(w0) - axisDir.dot(w0)) / denom;
};

/** Copy a bottom-up RGBA render-target readback into a top-down ImageData buffer. */
export const flipRowsBottomUp = (src: { subarray(begin: number, end: number): ArrayLike<number> }, dst: Uint8ClampedArray, width: number, height: number): void => {
    const row = width * 4;
    for (let y = 0; y < height; y++) dst.set(src.subarray((height - 1 - y) * row, (height - y) * row), y * row);
};
