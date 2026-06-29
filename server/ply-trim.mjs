// Self-contained PLY trim: keep or remove the gaussians inside a box/sphere
// region, writing a new PLY. Deliberately uses NO @playcanvas/splat-transform
// (its library entry externalizes playcanvas, which the packaged app prunes, so
// it crashes in production) and NO GPU — pure Node + fs, so it ships and runs
// anywhere the app does. Supports binary_little_endian and ascii PLY (the 3DGS
// formats); rejects big-endian (vanishingly rare for splats).
//
// Frame: splat-transform's PLY reader bakes a 180°-about-Z rotation
// (x, y, z -> -x, -y, z) onto positions before its -B/--filter-box / -S filters
// run, so the box/sphere the GUI shows live in that baked frame. We bake the same
// rotation onto each vertex before testing membership, so a trim removes/keeps
// exactly what the CLI's --filter-box would for the same region.
import fs from 'node:fs/promises';

const TYPE_SIZE = {
    char: 1, uchar: 1, int8: 1, uint8: 1,
    short: 2, ushort: 2, int16: 2, uint16: 2,
    int: 4, uint: 4, int32: 4, uint32: 4,
    float: 4, float32: 4, double: 8, float64: 8
};

const parseHeader = (buf) => {
    const marker = Buffer.from('end_header\n');
    const end = buf.indexOf(marker);
    if (end < 0) throw new Error('not a PLY file (no end_header)');
    const dataStart = end + marker.length;
    const lines = buf.toString('ascii', 0, end).split('\n').map((l) => l.trim());
    if (lines[0] !== 'ply') throw new Error('not a PLY file');
    let format = null;
    let vertexCount = 0;
    let inVertex = false;
    const props = [];
    for (const line of lines) {
        if (line.startsWith('format ')) {
            format = line.split(/\s+/)[1];
        } else if (line.startsWith('element ')) {
            const [, name, count] = line.split(/\s+/);
            inVertex = name === 'vertex';
            if (inVertex) vertexCount = Number(count);
        } else if (inVertex && line.startsWith('property ')) {
            const parts = line.split(/\s+/);
            if (parts[1] === 'list') throw new Error('PLY list properties are not supported in the vertex element');
            const type = parts[1];
            const name = parts[parts.length - 1];
            const size = TYPE_SIZE[type];
            if (!size) throw new Error(`unsupported PLY property type: ${type}`);
            props.push({ name, type, size });
        }
    }
    if (!format) throw new Error('PLY missing format line');
    let offset = 0;
    const byName = {};
    for (const p of props) { p.offset = offset; byName[p.name] = p; offset += p.size; }
    for (const k of ['x', 'y', 'z']) if (!byName[k]) throw new Error(`PLY vertex has no "${k}" property`);
    return { format, vertexCount, props, byName, stride: offset, dataStart };
};

const readLE = (buf, off, type) => {
    switch (type) {
        case 'float': case 'float32': return buf.readFloatLE(off);
        case 'double': case 'float64': return buf.readDoubleLE(off);
        case 'int': case 'int32': return buf.readInt32LE(off);
        case 'uint': case 'uint32': return buf.readUInt32LE(off);
        case 'short': case 'int16': return buf.readInt16LE(off);
        case 'ushort': case 'uint16': return buf.readUInt16LE(off);
        case 'char': case 'int8': return buf.readInt8(off);
        case 'uchar': case 'uint8': return buf.readUInt8(off);
        default: throw new Error(`cannot read type ${type}`);
    }
};

// Build the inside(x', y', z') predicate from the baked-frame box/sphere region.
// A blank/"-" box bound is unbounded on that side. Multiple shapes union.
const makeInside = ({ box, sphere }) => {
    const tests = [];
    if (Array.isArray(box) && box.length === 6) {
        const b = box.map((v) => (v === '' || v === '-' || v == null ? null : Number(v)));
        if (b.some((v) => v !== null && !Number.isFinite(v))) throw new Error('box has a non-numeric bound');
        tests.push((x, y, z) =>
            (b[0] === null || x >= b[0]) && (b[3] === null || x <= b[3]) &&
            (b[1] === null || y >= b[1]) && (b[4] === null || y <= b[4]) &&
            (b[2] === null || z >= b[2]) && (b[5] === null || z <= b[5]));
    }
    if (Array.isArray(sphere) && sphere.length === 4) {
        const [cx, cy, cz, r] = sphere.map(Number);
        if (![cx, cy, cz, r].every(Number.isFinite)) throw new Error('sphere has a non-numeric value');
        const r2 = r * r;
        tests.push((x, y, z) => ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) <= r2);
    }
    if (!tests.length) throw new Error('trim needs a box or sphere region');
    return (x, y, z) => tests.some((t) => t(x, y, z));
};

const rewriteCount = (headerStr, n) => {
    const out = headerStr.replace(/element vertex \d+/, `element vertex ${n}`);
    if (out === headerStr) throw new Error('could not rewrite the PLY vertex count');
    return out;
};

// Read srcAbs, keep (mode 'keep') or remove (mode 'remove') the gaussians inside
// the region, write outAbs. Returns { kept, total }. onProgress(i, n) is optional.
export const trimPly = async (srcAbs, outAbs, { box, sphere, mode = 'remove' }, onProgress) => {
    const buf = await fs.readFile(srcAbs);
    const h = parseHeader(buf);
    const inside = makeInside({ box, sphere });
    const keepInside = mode === 'keep';
    const { x: ox, y: oy, z: oz } = h.byName;
    const headerStr = buf.toString('ascii', 0, h.dataStart);

    if (h.format === 'binary_little_endian') {
        const kept = [];
        for (let i = 0; i < h.vertexCount; i++) {
            const base = h.dataStart + i * h.stride;
            // bake 180°-about-Z (x,y,z -> -x,-y,z) to match the CLI filter frame
            const x = -readLE(buf, base + ox.offset, ox.type);
            const y = -readLE(buf, base + oy.offset, oy.type);
            const z = readLE(buf, base + oz.offset, oz.type);
            if (inside(x, y, z) === keepInside) kept.push(buf.subarray(base, base + h.stride));
            if (onProgress && (i & 0x3ffff) === 0 && i) onProgress(i, h.vertexCount);
        }
        await fs.writeFile(outAbs, Buffer.concat([Buffer.from(rewriteCount(headerStr, kept.length), 'ascii'), ...kept]));
        return { kept: kept.length, total: h.vertexCount };
    }

    if (h.format === 'ascii') {
        const xi = h.props.findIndex((p) => p.name === 'x');
        const yi = h.props.findIndex((p) => p.name === 'y');
        const zi = h.props.findIndex((p) => p.name === 'z');
        const rows = buf.toString('utf8', h.dataStart).split('\n');
        const out = [];
        let seen = 0;
        for (const line of rows) {
            if (seen >= h.vertexCount) break;
            const t = line.trim();
            if (!t) continue;
            seen++;
            const c = t.split(/\s+/);
            const x = -Number(c[xi]);
            const y = -Number(c[yi]);
            const z = Number(c[zi]);
            if (inside(x, y, z) === keepInside) out.push(t);
            if (onProgress && (seen & 0x3ffff) === 0) onProgress(seen, h.vertexCount);
        }
        await fs.writeFile(outAbs, rewriteCount(headerStr, out.length) + out.join('\n') + (out.length ? '\n' : ''));
        return { kept: out.length, total: h.vertexCount };
    }

    throw new Error(`unsupported PLY format "${h.format}" — convert to binary_little_endian or ascii PLY first`);
};
