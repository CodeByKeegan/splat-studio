// Generates workspace/demo-room.ply — a synthetic gaussian-splat scan of a small
// room (floor, four walls, a pillar and a table) for exercising the conversion and
// collision pipeline without needing a real capture.
//
// Coordinates follow the usual 3DGS PLY convention (Y-down), which is why viewers
// flip splats 180° about X. "Up" in this file is -Y: the floor sits at y=0 and the
// walls extend to y=-WALL_H.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(rootDir, 'workspace', 'demo-room.ply');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const SH_C0 = 0.28209479177387814;
const colorToSH = (c) => (c - 0.5) / SH_C0;
const logit = (p) => Math.log(p / (1 - p));

const ROOM = 3.0;     // half-extent in x/z
const WALL_H = 2.5;
const STEP = 0.06;
const SCALE = 0.045;  // gaussian radius (sigma)

const splats = [];
const jitter = () => (Math.random() - 0.5) * STEP * 0.6;

const add = (x, y, z, [r, g, b], opacity = 0.95) => {
    splats.push([
        x + jitter(), y + jitter() * 0.3, z + jitter(),
        colorToSH(r), colorToSH(g), colorToSH(b),
        logit(opacity),
        Math.log(SCALE), Math.log(SCALE), Math.log(SCALE),
        1, 0, 0, 0 // identity quaternion (rot_0 = w)
    ]);
};

// floor (checkered)
for (let x = -ROOM; x <= ROOM; x += STEP) {
    for (let z = -ROOM; z <= ROOM; z += STEP) {
        const check = (Math.floor(x) + Math.floor(z)) % 2 === 0;
        const tone = check ? 0.55 : 0.4;
        add(x, 0, z, [tone, tone * 0.95, tone * 0.85]);
    }
}

// walls (each a different hue so orientation is obvious)
const WALL_COLORS = [
    [0.65, 0.45, 0.4],  // +x
    [0.4, 0.55, 0.65],  // -x
    [0.45, 0.6, 0.45],  // +z
    [0.6, 0.6, 0.45]    // -z
];
for (let h = 0; h >= -WALL_H; h -= STEP) {
    for (let t = -ROOM; t <= ROOM; t += STEP) {
        add(ROOM, h, t, WALL_COLORS[0]);
        add(-ROOM, h, t, WALL_COLORS[1]);
        add(t, h, ROOM, WALL_COLORS[2]);
        add(t, h, -ROOM, WALL_COLORS[3]);
    }
}

// pillar: box at (1.2, -0.8), 0.4 wide, full height
for (let h = 0; h >= -WALL_H; h -= STEP) {
    for (let t = -0.2; t <= 0.2; t += STEP) {
        add(1.2 + t, h, -0.8 - 0.2, [0.7, 0.3, 0.3]);
        add(1.2 + t, h, -0.8 + 0.2, [0.7, 0.3, 0.3]);
        add(1.2 - 0.2, h, -0.8 + t, [0.7, 0.3, 0.3]);
        add(1.2 + 0.2, h, -0.8 + t, [0.7, 0.3, 0.3]);
    }
}

// table: slab 0.75m above the floor with four legs
for (let x = -1.8; x <= -0.6; x += STEP) {
    for (let z = 0.4; z <= 1.4; z += STEP) {
        add(x, -0.75, z, [0.5, 0.35, 0.25]);
    }
}
for (const lx of [-1.7, -0.7]) {
    for (const lz of [0.5, 1.3]) {
        for (let h = 0; h >= -0.75; h -= STEP) add(lx, h, lz, [0.4, 0.28, 0.2]);
    }
}

// a few floaters to give --filter-cluster something to remove
for (let i = 0; i < 40; i++) {
    add(
        (Math.random() - 0.5) * 12,
        -4 - Math.random() * 3,
        (Math.random() - 0.5) * 12,
        [0.9, 0.9, 0.9],
        0.6
    );
}

const FLOATS_PER_SPLAT = 14;
const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    `element vertex ${splats.length}\n` +
    ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
        'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
        .map((p) => `property float ${p}`).join('\n') +
    '\nend_header\n';

const headerBuf = Buffer.from(header, 'ascii');
const body = Buffer.alloc(splats.length * FLOATS_PER_SPLAT * 4);
splats.forEach((s, i) => {
    s.forEach((v, j) => body.writeFloatLE(v, (i * FLOATS_PER_SPLAT + j) * 4));
});

fs.writeFileSync(outPath, Buffer.concat([headerBuf, body]));
console.log(`Wrote ${outPath}: ${splats.length} gaussians, ${(headerBuf.length + body.length) / 1e6} MB`);
console.log('Collision hint: --seed-pos is in engine space (Y-up); 1m above the floor is 0,1,0.');
