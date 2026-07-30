// Manual diagnostic (not wired to any npm script; reads from ./workspace).
// Validates the voxel octree parser against real splat-transform output:
// traversal counts must match the .voxel.json metadata and all boxes must lie
// within gridBounds.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVoxelOctree } from '../client/src/voxel-parser.js';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'workspace');

for (const name of process.argv.slice(2)) {
    const meta = JSON.parse(fs.readFileSync(path.join(workspace, `${name}.voxel.json`), 'utf8'));
    const bin = fs.readFileSync(path.join(workspace, `${name}.voxel.bin`));
    const t0 = performance.now();
    const result = parseVoxelOctree(meta, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
    const ms = (performance.now() - t0).toFixed(0);

    const ok = (label, cond) => console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`);
    console.log(`${name}: ${result.count} boxes in ${ms}ms (interior ${result.stats.interior}, mixed ${result.stats.mixed}, solid ${result.stats.solid}, truncated ${result.truncated})`);
    ok(`interior matches meta (${meta.numInteriorNodes})`, result.stats.interior === meta.numInteriorNodes);
    ok(`mixed matches meta (${meta.numMixedLeaves})`, result.stats.mixed === meta.numMixedLeaves);

    let inBounds = true;
    const { min, max } = meta.gridBounds;
    const eps = 1e-4;
    for (let i = 0; i < result.count; i++) {
        const o = i * 6;
        for (let a = 0; a < 3; a++) {
            const lo = result.boxes[o + a] - result.boxes[o + 3 + a] / 2;
            const hi = result.boxes[o + a] + result.boxes[o + 3 + a] / 2;
            if (lo < min[a] - eps || hi > max[a] + eps) inBounds = false;
        }
    }
    ok('all boxes within gridBounds', inBounds);
}
