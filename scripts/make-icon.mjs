// Generates build/icon.ico (and build/icon.png) — no native deps, pure JS.
// A dark rounded-square tile with a few additive "gaussian splat" glows.
import { PNG } from 'pngjs';
import pngToIco from 'png-to-ico';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

// rounded-rect coverage with ~1px antialiasing (0 outside, 1 inside)
const tileAlpha = (x, y, s, r) => {
    const dx = Math.abs(x - s / 2) - (s / 2 - r);
    const dy = Math.abs(y - s / 2) - (s / 2 - r);
    const sdf = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
    return clamp(0.5 - sdf, 0, 1);
};

// blobs in unit space (0..1) so the design scales to any icon size
const BLOBS = [
    { x: 0.36, y: 0.40, sigma: 0.16, c: [60, 220, 200], k: 1.15 },  // teal
    { x: 0.64, y: 0.36, sigma: 0.13, c: [120, 130, 255], k: 1.05 }, // indigo
    { x: 0.58, y: 0.64, sigma: 0.17, c: [240, 90, 170], k: 1.10 },  // magenta
    { x: 0.40, y: 0.66, sigma: 0.12, c: [255, 170, 70], k: 0.95 }   // amber
];

const render = (size) => {
    const png = new PNG({ width: size, height: size });
    const r = size * 0.22; // corner radius
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = (x + 0.5) / size;
            const v = (y + 0.5) / size;
            // vertical background gradient
            let cr = lerp(28, 14, v);
            let cg = lerp(28, 14, v);
            let cb = lerp(36, 20, v);
            // additive gaussian glows
            for (const b of BLOBS) {
                const d2 = (u - b.x) ** 2 + (v - b.y) ** 2;
                const g = b.k * Math.exp(-d2 / (2 * b.sigma * b.sigma));
                cr += g * b.c[0];
                cg += g * b.c[1];
                cb += g * b.c[2];
            }
            const a = tileAlpha(x + 0.5, y + 0.5, size, r);
            const i = (y * size + x) * 4;
            png.data[i] = clamp(cr, 0, 255);
            png.data[i + 1] = clamp(cg, 0, 255);
            png.data[i + 2] = clamp(cb, 0, 255);
            png.data[i + 3] = Math.round(a * 255);
        }
    }
    return PNG.sync.write(png);
};

fs.mkdirSync(outDir, { recursive: true });
const sizes = [256, 128, 64, 48, 32, 16];
const buffers = sizes.map(render);
fs.writeFileSync(path.join(outDir, 'icon.png'), buffers[0]);
const ico = await pngToIco(buffers);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log(`wrote build/icon.ico (${sizes.join(',')}) and build/icon.png`);
