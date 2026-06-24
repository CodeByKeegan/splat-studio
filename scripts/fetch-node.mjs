// Stages a standalone node.exe under vendor/node/ for the packaged app to bundle
// (electron-builder copies it via extraResources). The splat-transform CLI runs
// under this real Node — Dawn's native WebGPU device crashes inside Electron.
//
// By default it copies the Node binary running this script (guaranteed ABI- and
// platform-compatible with the build machine). Set SPLAT_NODE_SOURCE to copy a
// specific node.exe instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destDir = path.join(root, 'vendor', 'node');
const dest = path.join(destDir, process.platform === 'win32' ? 'node.exe' : 'node');
const src = process.env.SPLAT_NODE_SOURCE || process.execPath;

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
const mb = (fs.statSync(dest).size / 1e6).toFixed(1);
console.log(`staged ${path.relative(root, dest)} (${mb} MB) from ${src} — Node ${process.version}`);
