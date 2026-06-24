// Diagnostic: one tight gaussian blob at a known asymmetric PLY-space position.
// Voxelize it and read the collision GLB bounds to determine exactly how
// splat-transform maps splat space -> GLB space (sign of each axis).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(rootDir, 'workspace', 'axis-test.ply');

const POS = [2, -1, 0.5]; // asymmetric on every axis
const splats = [];
for (let i = 0; i < 500; i++) {
    const jitter = () => (Math.random() - 0.5) * 0.3;
    splats.push([
        POS[0] + jitter(), POS[1] + jitter(), POS[2] + jitter(),
        0, 0, 0,            // f_dc
        2.94,               // opacity (logit 0.95)
        Math.log(0.05), Math.log(0.05), Math.log(0.05),
        1, 0, 0, 0
    ]);
}

const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${splats.length}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
const body = Buffer.alloc(splats.length * 14 * 4);
splats.forEach((s, i) => s.forEach((v, j) => body.writeFloatLE(v, (i * 14 + j) * 4)));
fs.writeFileSync(outPath, Buffer.concat([Buffer.from(header, 'ascii'), body]));
console.log(`blob at PLY-space (${POS.join(', ')}) -> ${outPath}`);
console.log('expected GLB center if convention is R_x(180) (y,z negate): (2, 1, -0.5)');
console.log('expected GLB center if convention is R_z(180) (x,y negate): (-2, 1, 0.5)');
