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
import { createWriteStream } from 'node:fs';

const TYPE_SIZE = {
    char: 1, uchar: 1, int8: 1, uint8: 1,
    short: 2, ushort: 2, int16: 2, uint16: 2,
    int: 4, uint: 4, int32: 4, uint32: 4,
    float: 4, float32: 4, double: 8, float64: 8
};

// parse the PLY header → { format, vertexCount, props, byName, stride, dataStart }
const parseHeader = (buf) => {
    const marker = Buffer.from('end_header');
    const end = buf.indexOf(marker);
    if (end < 0) throw new Error('not a PLY file (no end_header)');
    // advance past the marker and the following line terminator (LF or CRLF)
    let dataStart = end + marker.length;
    if (buf[dataStart] === 0x0d) dataStart++; // CR
    if (buf[dataStart] === 0x0a) dataStart++; // LF
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

// read one little-endian scalar of the given PLY type
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
    // anchor to the real declaration line (parseHeader gates on line.startsWith('element ')),
    // so a "comment ... element vertex 999 ..." line cannot be matched; detect "not found"
    // by testing for a match (an unchanged count is a valid no-op, not an error).
    const re = /^element vertex \d+/m;
    if (!re.test(headerStr)) throw new Error('could not find the PLY vertex count');
    return headerStr.replace(re, `element vertex ${n}`);
};

// Read srcAbs, keep (mode 'keep') or remove (mode 'remove') the gaussians inside
// the region, write outAbs. Returns { kept, total }. onProgress(i, n) is optional.
// Binary PLYs are processed in fixed-size windows, never fully in memory —
// multi-GB scans are in-domain and must not OOM (or hit Node's buffer cap).
export const trimPly = async (srcAbs, outAbs, { box, sphere, mode = 'remove' }, onProgress) => {
    const fh = await fs.open(srcAbs, 'r');
    try {
        const { size } = await fh.stat();
        // header window: grow until end_header appears (cap 4 MB — real headers are KBs)
        const HEADER_CAP = 4 * 1024 * 1024;
        let headBuf = Buffer.alloc(0);
        while (headBuf.indexOf('end_header') < 0 && headBuf.length < Math.min(size, HEADER_CAP)) {
            const next = Math.min(size, HEADER_CAP, Math.max(64 * 1024, headBuf.length * 2));
            const buf = Buffer.alloc(next);
            const { bytesRead } = await fh.read(buf, 0, next, 0);
            headBuf = buf.subarray(0, bytesRead);
        }
        const h = parseHeader(headBuf);
        const inside = makeInside({ box, sphere });
        const keepInside = mode === 'keep';
        const { x: ox, y: oy, z: oz } = h.byName;
        const headerStr = headBuf.toString('ascii', 0, h.dataStart);

        if (h.format === 'binary_little_endian') {
            // validate the body length up front so a truncated/corrupt PLY yields a clear
            // diagnostic instead of an opaque RangeError (or a byte-misaligned output)
            const need = h.dataStart + h.vertexCount * h.stride;
            if (need > size) {
                throw new Error(`PLY is truncated: header declares ${h.vertexCount} vertices but the body is too short`);
            }
            if ((size - h.dataStart) % h.stride !== 0) {
                throw new Error('PLY body has unexpected trailing data (length is not a whole number of vertex records — wrong stride?)');
            }
            const CHUNK_RECORDS = Math.max(1, Math.floor((8 * 1024 * 1024) / h.stride));
            const chunkBuf = Buffer.alloc(CHUNK_RECORDS * h.stride);
            // run fn(chunkBuf, firstIndex, count) over every window of records
            const eachWindow = async (fn) => {
                for (let i = 0; i < h.vertexCount; i += CHUNK_RECORDS) {
                    const count = Math.min(CHUNK_RECORDS, h.vertexCount - i);
                    const bytes = count * h.stride;
                    const { bytesRead } = await fh.read(chunkBuf, 0, bytes, h.dataStart + i * h.stride);
                    if (bytesRead !== bytes) throw new Error('PLY read came up short');
                    await fn(chunkBuf, i, count);
                }
            };
            // bake 180°-about-Z (x,y,z -> -x,-y,z) to match the CLI filter frame
            const survivesAt = (buf, off) => {
                const x = -readLE(buf, off + ox.offset, ox.type);
                const y = -readLE(buf, off + oy.offset, oy.type);
                const z = readLE(buf, off + oz.offset, oz.type);
                return inside(x, y, z) === keepInside;
            };
            // pass 1: count survivors (so the header carries the final count)
            let keptCount = 0;
            await eachWindow((buf, i, count) => {
                for (let k = 0; k < count; k++) if (survivesAt(buf, k * h.stride)) keptCount++;
            });
            // pass 2: stream the header + each window's surviving records
            const stream = createWriteStream(outAbs);
            const write = (chunk) => new Promise((resolve, reject) => {
                const onError = (err) => { stream.off('error', onError); reject(err); };
                stream.once('error', onError);
                if (stream.write(chunk)) {
                    stream.off('error', onError);
                    resolve();
                } else {
                    stream.once('drain', () => { stream.off('error', onError); resolve(); });
                }
            });
            try {
                await write(Buffer.from(rewriteCount(headerStr, keptCount), 'ascii'));
                await eachWindow(async (buf, i, count) => {
                    // copy survivors out of the reused window before the next read overwrites it
                    const keep = [];
                    for (let k = 0; k < count; k++) {
                        const off = k * h.stride;
                        if (survivesAt(buf, off)) keep.push(Buffer.from(buf.subarray(off, off + h.stride)));
                    }
                    if (keep.length) await write(Buffer.concat(keep));
                    if (onProgress && i) onProgress(i + count, h.vertexCount);
                });
                await new Promise((resolve, reject) => {
                    stream.once('finish', resolve);
                    stream.once('error', reject);
                    stream.end();
                });
            } catch (err) {
                stream.destroy();
                throw err;
            }
            return { kept: keptCount, total: h.vertexCount };
        }

        if (h.format === 'ascii') {
            // toString('utf8') throws a cryptic ERR_STRING_TOO_LONG past ~512 MB;
            // guard well under that with a clear, actionable message
            if (size - h.dataStart > 256 * 1024 * 1024) {
                throw new Error('ASCII PLY too large to trim (>~256 MB) — convert to binary_little_endian PLY first');
            }
            const buf = await fs.readFile(srcAbs);
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
    } finally {
        await fh.close();
    }
};
