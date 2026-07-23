// Types for voxel-parser.js (see its header for the .voxel.bin format spec).
export interface VoxelMeta {
    version: string;
    gridBounds: { min: [number, number, number]; max: [number, number, number] };
    sceneBounds: { min: [number, number, number]; max: [number, number, number] };
    voxelResolution: number;
    leafSize: number;
    treeDepth: number;
    numInteriorNodes: number;
    numMixedLeaves: number;
    nodeCount: number;
    leafDataCount: number;
}

export interface VoxelParseResult {
    /** [cx, cy, cz, sx, sy, sz] per box, in splat-transform's voxel space */
    boxes: Float32Array;
    count: number;
    truncated: boolean;
    stats: { interior: number; mixed: number; solid: number };
}

export function parseVoxelOctree(meta: VoxelMeta, bin: ArrayBuffer, maxBoxes?: number): VoxelParseResult;
