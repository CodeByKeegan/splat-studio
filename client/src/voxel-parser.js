/**
 * Parser for splat-transform's sparse voxel octree (.voxel.json + .voxel.bin).
 *
 * Format (reverse-engineered from @playcanvas/splat-transform 2.5.2 writeVoxel —
 * see flattenDenseLevels/flattenTreeFromLevels in dist/index.mjs):
 * - .voxel.bin = nodes[nodeCount] then leafData[leafDataCount], little-endian uint32.
 * - The octree subdivides space in 4x4x4-voxel *blocks*; the root covers
 *   2^treeDepth blocks per axis anchored at gridBounds.min.
 * - Node word at any level may be SOLID_LEAF_MARKER (0xFF000000): the node's
 *   entire region is solid.
 * - Otherwise, above block level: interior word = (childMask << 24) | childStart.
 *   Children sit contiguously at nodes[childStart..] for each set bit of
 *   childMask in oct order (oct bit = x | y<<1 | z<<2).
 * - At block level (level 0): word = index into leafData pairs; the pair is a
 *   64-bit occupancy mask of the 4x4x4 block, bit = x + y*4 + z*16
 *   (lo word = bits 0-31, hi word = bits 32-63).
 *
 * Returns axis-aligned boxes in splat-transform's voxel space. Solid regions
 * become one box; mixed leaves emit one box per run of consecutive set bits
 * along x.
 */

const SOLID_LEAF_MARKER = 0xFF000000;

/**
 * @param {object} meta - parsed .voxel.json
 * @param {ArrayBuffer} bin - raw .voxel.bin contents
 * @param {number} [maxBoxes] - emission cap
 * @returns {{ boxes: Float32Array, count: number, truncated: boolean,
 *            stats: { interior: number, mixed: number, solid: number } }}
 *          boxes = [cx, cy, cz, sx, sy, sz] per box
 */
export const parseVoxelOctree = (meta, bin, maxBoxes = 1_500_000) => {
    const words = new Uint32Array(bin);
    if (words.length !== meta.nodeCount + meta.leafDataCount) {
        throw new Error(`voxel.bin length ${words.length} != nodeCount ${meta.nodeCount} + leafDataCount ${meta.leafDataCount}`);
    }
    const nodes = words.subarray(0, meta.nodeCount);
    const leafData = words.subarray(meta.nodeCount);
    const res = meta.voxelResolution;
    const blockSize = res * meta.leafSize; // leafSize is 4
    const [ox, oy, oz] = meta.gridBounds.min;

    const boxes = new Float32Array(maxBoxes * 6);
    let count = 0;
    let truncated = false;
    const stats = { interior: 0, mixed: 0, solid: 0 };

    const emit = (cx, cy, cz, sx, sy, sz) => {
        if (count >= maxBoxes) {
            truncated = true;
            return;
        }
        const o = count * 6;
        boxes[o] = cx; boxes[o + 1] = cy; boxes[o + 2] = cz;
        boxes[o + 3] = sx; boxes[o + 4] = sy; boxes[o + 5] = sz;
        count++;
    };

    // entries: nodeIndex, block x/y/z of region min, level (region = 2^level blocks)
    const stack = [[0, 0, 0, 0, meta.treeDepth]];
    while (stack.length) {
        const [ni, bx, by, bz, level] = stack.pop();
        const word = nodes[ni];

        if (word === SOLID_LEAF_MARKER) {
            stats.solid++;
            const s = (1 << level) * blockSize;
            emit(ox + bx * blockSize + s / 2, oy + by * blockSize + s / 2, oz + bz * blockSize + s / 2, s, s, s);
            continue;
        }

        if (level === 0) {
            stats.mixed++;
            const lo = leafData[word * 2];
            const hi = leafData[word * 2 + 1];
            const x0 = ox + bx * blockSize;
            const y0 = oy + by * blockSize;
            const z0 = oz + bz * blockSize;
            for (let lz = 0; lz < 4; lz++) {
                for (let ly = 0; ly < 4; ly++) {
                    const bit = ly * 4 + lz * 16; // x-row base; rows never straddle the word split
                    const nib = (bit < 32 ? lo >>> bit : hi >>> (bit - 32)) & 0xF;
                    if (!nib) continue;
                    let x = 0;
                    while (x < 4) {
                        if (nib & (1 << x)) {
                            let run = 1;
                            while (x + run < 4 && (nib & (1 << (x + run)))) run++;
                            emit(x0 + (x + run / 2) * res, y0 + (ly + 0.5) * res, z0 + (lz + 0.5) * res, run * res, res, res);
                            x += run;
                        } else {
                            x++;
                        }
                    }
                }
            }
            continue;
        }

        stats.interior++;
        const childMask = word >>> 24;
        let child = word & 0xFFFFFF;
        const half = 1 << (level - 1);
        for (let oct = 0; oct < 8; oct++) {
            if (childMask & (1 << oct)) {
                stack.push([
                    child++,
                    bx + ((oct & 1) ? half : 0),
                    by + ((oct & 2) ? half : 0),
                    bz + ((oct & 4) ? half : 0),
                    level - 1
                ]);
            }
        }
    }

    return { boxes: boxes.slice(0, count * 6), count, truncated, stats };
};
