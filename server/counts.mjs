// Cheap per-file gaussian counts for the files listing, read from format
// headers / metadata only — never by running the CLI. Ranged reads with
// decompression caps keep multi-GB archives and crafted bombs safe.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

// Cached per (path, mtime); null (no cheap count / unreadable) is cached too.
const countsCache = new Map();

// ranged fd read: [position, position + length)
const readRange = async (abs, position, length) => {
    const fh = await fs.open(abs, 'r');
    try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buf, 0, length, position);
        return buf.subarray(0, bytesRead);
    } finally {
        await fh.close();
    }
};

// streamed-LOD lod-meta.json: total count + per-level counts
const readLodMetaCounts = async (abs) => {
    const meta = JSON.parse(await fs.readFile(abs, 'utf8'));
    if (!Number.isFinite(meta?.count)) return null;
    const value = { gaussians: meta.count };
    if (Array.isArray(meta.counts) && meta.counts.every(Number.isFinite)) value.lodCounts = meta.counts;
    return value;
};

// unbundled-SOG meta.json
const readSogMetaCounts = async (abs) => {
    const meta = JSON.parse(await fs.readFile(abs, 'utf8'));
    return Number.isFinite(meta?.count) ? { gaussians: meta.count } : null;
};

// .ply / .compressed.ply: "element vertex N" in the ascii header
const readPlyCounts = async (abs) => {
    const head = (await readRange(abs, 0, 64 * 1024)).toString('ascii');
    const end = head.indexOf('end_header');
    if (end < 0) return null;
    const m = head.slice(0, end).match(/^element vertex (\d+)$/m);
    return m ? { gaussians: Number(m[1]) } : null;
};

// .sog (ZIP): locate meta.json via the central directory using ranged reads
// only (archives can be GBs). ZIP64 (0xffffffff fields) out of scope -> null.
const readSogCounts = async (abs) => {
    const { size } = await fs.stat(abs);
    const tail = await readRange(abs, Math.max(0, size - 66 * 1024), Math.min(size, 66 * 1024));
    let eocd = -1; // scan backwards over a possible archive comment
    for (let i = tail.length - 22; i >= 0 && eocd < 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) eocd = i;
    }
    if (eocd < 0) return null;
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff || cdSize > 4 * 1024 * 1024 || cdOffset + cdSize > size) return null;
    const cd = await readRange(abs, cdOffset, cdSize);
    if (cd.length !== cdSize) return null;
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
        const method = cd.readUInt16LE(p + 10);
        const compSize = cd.readUInt32LE(p + 20);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        const localOffset = cd.readUInt32LE(p + 42);
        if (p + 46 + nameLen > cd.length) return null;
        if (cd.toString('utf8', p + 46, p + 46 + nameLen) === 'meta.json') {
            if (compSize === 0xffffffff || localOffset === 0xffffffff || compSize > 8 * 1024 * 1024) return null;
            const local = await readRange(abs, localOffset, 30);
            if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) return null;
            // data start uses the LOCAL header's name/extra lengths
            const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
            if (dataStart + compSize > size) return null;
            const data = await readRange(abs, dataStart, compSize);
            if (data.length !== compSize) return null;
            // cap the DECOMPRESSED size too — a real meta.json is a few KB
            const json = method === 0 ? data
                : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 8 * 1024 * 1024 }) : null;
            if (!json) return null;
            const meta = JSON.parse(json.toString('utf8'));
            return Number.isFinite(meta?.count) ? { gaussians: meta.count } : null;
        }
        p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
};

// .splat (antimatter): fixed 32 bytes per gaussian
const readSplatCounts = async (abs) => {
    const { size } = await fs.stat(abs);
    return size > 0 && size % 32 === 0 ? { gaussians: size / 32 } : null;
};

// .spz: v4 leads with a plaintext NGSP header; v1-3 are gzip end-to-end with
// the same header at the start of the stream. numPoints at offset 8 either way.
const readSpzCounts = async (abs) => {
    let head = await readRange(abs, 0, 16 * 1024);
    if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
        head = zlib.gunzipSync(head, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 16 * 1024 * 1024 });
    }
    if (head.length < 12 || head.readUInt32LE(0) !== 0x5053474e) return null;
    return { gaussians: head.readUInt32LE(8) };
};

// dispatch by name; any failure -> null (a listing never rejects on a bad file)
const readCounts = async (abs, name) => {
    try {
        if (name.endsWith('lod-meta.json')) return await readLodMetaCounts(abs);
        if (name.endsWith('meta.json')) return await readSogMetaCounts(abs);
        if (/\.ply$/i.test(name)) return await readPlyCounts(abs);
        if (/\.sog$/i.test(name)) return await readSogCounts(abs);
        if (/\.splat$/i.test(name)) return await readSplatCounts(abs);
        if (/\.spz$/i.test(name)) return await readSpzCounts(abs);
        return null; // .ksplat/.lcc/.lcc2/.glb: no cheap header count
    } catch {
        return null;
    }
};

// cached (path, mtime) wrapper over readCounts
export const countsFor = async (abs, mtime, name) => {
    const hit = countsCache.get(abs);
    if (hit && hit.mtime === mtime) return hit.value;
    const value = await readCounts(abs, name);
    countsCache.set(abs, { mtime, value });
    return value;
};


// drop cached counts at or under a path (deleted file/folder)
export const evictCounts = (absPrefix) => {
    for (const key of countsCache.keys()) {
        if (key === absPrefix || key.startsWith(absPrefix + path.sep)) countsCache.delete(key);
    }
};

// full reset (workspace switch)
export const clearCounts = () => countsCache.clear();
