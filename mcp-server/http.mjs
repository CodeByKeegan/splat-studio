// Thin HTTP client to the Splat Studio loopback API (server/index.mjs).
// The MCP process speaks only HTTP; it NEVER launches the app. All tools import
// apiGet/apiPost/apiDelete/apiUpload from here — no parallel clients.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError, ConnError } from './errors.mjs';

// Port resolution order (design decision 20):
//   SPLAT_API_PORT env -> userData/port.json hint (written by electron/main.mjs) -> 5174.
const hintFiles = () => {
    const names = ['Splat Studio', 'splat-studio'];
    const dirs = [];
    if (process.platform === 'win32' && process.env.APPDATA) names.forEach((n) => dirs.push(path.join(process.env.APPDATA, n)));
    else if (process.platform === 'darwin') names.forEach((n) => dirs.push(path.join(os.homedir(), 'Library', 'Application Support', n)));
    else names.forEach((n) => dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), n)));
    return dirs.map((d) => path.join(d, 'port.json'));
};

const readHint = () => {
    for (const f of hintFiles()) {
        try {
            const j = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (j && Number.isFinite(Number(j.port))) return Number(j.port);
        } catch { /* try the next candidate */ }
    }
    return null;
};

const resolveBase = () => {
    if (process.env.SPLAT_API_BASE) return process.env.SPLAT_API_BASE.replace(/\/+$/, '');
    const host = process.env.SPLAT_API_HOST || '127.0.0.1';
    const port = Number(process.env.SPLAT_API_PORT) || readHint() || 5174;
    return `http://${host}:${port}`;
};

export const BASE = resolveBase();

const isUnreachable = (e) => {
    const s = String(e?.cause?.code || e?.code || e?.cause?.message || e?.message || e);
    return /ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|fetch failed|socket hang up|network/i.test(s);
};

async function req(method, p, { body, headers, duplex } = {}) {
    const url = BASE + p;
    let res;
    try {
        res = await fetch(url, { method, headers, body, duplex });
    } catch (e) {
        if (isUnreachable(e)) throw new ConnError(url, e);
        throw e;
    }
    const ct = res.headers.get('content-type') || '';
    const payload = ct.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
    if (!res.ok) throw new HttpError(res.status, payload, url);
    return payload;
}

export const apiGet = (p) => req('GET', p);
export const apiPost = (p, body) =>
    req('POST', p, { body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } });
export const apiDelete = (p) => req('DELETE', p);

// stream a local file to POST /api/upload (8 GB cap server-side; never buffered here)
export const apiUploadFile = (p, absPath) => {
    const size = fs.statSync(absPath).size;
    const stream = fs.createReadStream(absPath);
    return req('POST', p, {
        body: stream,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) },
        duplex: 'half'
    });
};

// querystring helper that encodes project / input names safely
export const qs = (obj) =>
    '?' + Object.entries(obj)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
