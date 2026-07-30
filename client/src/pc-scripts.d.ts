// Minimal typing for the engine's untyped camera-controls ESM script — only the
// surface Splat Studio uses (it ships without declarations).
declare module 'playcanvas/scripts/esm/camera-controls.mjs' {
    import { Script, Vec3 } from 'playcanvas';
    class CameraControls extends Script {
        enabled: boolean;
        enableFly: boolean;
        enableOrbit: boolean;
        enablePan: boolean;
        reset(focus: Vec3, eye: Vec3): void;
    }
    export { CameraControls };
}
