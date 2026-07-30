// Material factories for SplatViewer's overlay layers. The viewer keeps the
// returned instances as fields and mutates them at runtime (style toggles,
// color/opacity controls), so each factory returns a fresh material.
import * as pc from 'playcanvas';

// shared unlit-overlay recipe (setting opacity implies normal blending)
const unlitOverlay = (o: {
    emissive?: pc.Color;
    diffuse?: pc.Color;
    opacity?: number;
    depthTest?: boolean;
    depthWrite?: boolean;
    cullNone?: boolean;
}): pc.StandardMaterial => {
    const m = new pc.StandardMaterial();
    m.useLighting = false;
    if (o.diffuse) m.diffuse = o.diffuse;
    if (o.emissive) m.emissive = o.emissive;
    if (o.opacity !== undefined) { m.blendType = pc.BLEND_NORMAL; m.opacity = o.opacity; }
    if (o.depthTest !== undefined) m.depthTest = o.depthTest;
    if (o.depthWrite !== undefined) m.depthWrite = o.depthWrite;
    if (o.cullNone) m.cull = pc.CULLFACE_NONE;
    m.update();
    return m;
};

/** Collision wireframe: unlit green X-ray lines (depthTest toggled by style). */
export const makeWireMaterial = (): pc.StandardMaterial =>
    unlitOverlay({ diffuse: new pc.Color(0, 0, 0), emissive: new pc.Color(0, 1, 0.4), opacity: 0.6, depthTest: false, depthWrite: false });

/** Voxel boxes: unlit translucent amber. */
export const makeVoxelMaterial = (): pc.StandardMaterial =>
    unlitOverlay({ diffuse: new pc.Color(0, 0, 0), emissive: new pc.Color(1, 0.62, 0.25), opacity: 0.35, depthWrite: false });

/** Bounding-box overlay: a wireframe unit cube scaled to the splat's world AABB. */
export const makeBoundsMaterial = (): pc.StandardMaterial =>
    unlitOverlay({ emissive: new pc.Color(0.45, 0.85, 1), depthTest: false, depthWrite: false });

/**
 * Depth-only prepass: fills the depth buffer so the wireframe becomes
 * hidden-line instead of X-ray (draws no color).
 */
export const makeDepthMaterial = (): pc.StandardMaterial => {
    const m = new pc.StandardMaterial();
    m.redWrite = false;
    m.greenWrite = false;
    m.blueWrite = false;
    m.alphaWrite = false;
    m.depthWrite = true;
    m.update();
    return m;
};

/** Lit translucent surface for placement/carve inspection. */
export const makeSolidMaterial = (): pc.StandardMaterial => {
    const m = new pc.StandardMaterial();
    m.diffuse = new pc.Color(0.42, 0.55, 0.5);
    m.opacity = 0.8;
    m.blendType = pc.BLEND_NORMAL;
    m.depthWrite = true;
    m.cull = pc.CULLFACE_NONE;
    m.twoSidedLighting = true;
    m.update();
    return m;
};

/** Seed marker: yellow, always findable through the splat. */
export const makeSeedMaterial = (): pc.StandardMaterial =>
    unlitOverlay({ emissive: new pc.Color(1, 0.85, 0.1), depthTest: false });

/** Carve-capsule preview: translucent cyan, visible from inside too. */
export const makeCapsuleMaterial = (): pc.StandardMaterial =>
    unlitOverlay({ emissive: new pc.Color(0.2, 0.8, 1), opacity: 0.3, depthTest: false, depthWrite: false, cullNone: true });

/** Measure/origin markers (cloned + tinted per marker); hidden via CPU occlusion, not the depth buffer. */
export const makeEditMaterial = (): pc.StandardMaterial =>
    unlitOverlay({ depthTest: false });

/** Crop-region wireframe: cyan, always findable through the splat. */
export const makeCropMaterial = (): pc.StandardMaterial =>
    unlitOverlay({ emissive: new pc.Color(0.3, 0.7, 1), opacity: 0.9, depthTest: false, depthWrite: false });

/** Collision-region wireframe: amber, distinct from the cyan crop/bounds. */
export const makeRegionMaterial = (): pc.StandardMaterial =>
    unlitOverlay({ emissive: new pc.Color(0.95, 0.6, 0.15), opacity: 0.95, depthTest: false, depthWrite: false });

/** Optional translucent region face fill (both sides, so it reads from inside a room scan too). */
export const makeRegionFillMaterial = (): pc.StandardMaterial =>
    unlitOverlay({ emissive: new pc.Color(0.95, 0.6, 0.15), opacity: 0.15, depthTest: false, depthWrite: false, cullNone: true });

/** Region drag handles (box faces + sphere radius knob); retinted per target family. */
export const makeRegionHandleMaterial = (): pc.StandardMaterial =>
    unlitOverlay({ emissive: new pc.Color(1, 0.85, 0.3), depthTest: false, depthWrite: false });
