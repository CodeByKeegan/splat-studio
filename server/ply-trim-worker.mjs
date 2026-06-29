// Trim worker — spawned as a job (process.execPath ply-trim-worker.mjs <json>),
// so it slots into the existing job system (log streaming, idle watchdog, output
// detection + autoload) with no special handling. Paths are project-relative and
// resolved against cwd (the job's project dir). Progress lines keep the watchdog
// armed on big files.
import path from 'node:path';
import { trimPly } from './ply-trim.mjs';

const opts = JSON.parse(process.argv[2] ?? '{}');
const cwd = process.cwd();
const srcAbs = path.resolve(cwd, ...String(opts.src).split('/'));
const outAbs = path.resolve(cwd, ...String(opts.out).split('/'));

const t0 = Date.now();
const fmt = (n) => n.toLocaleString();
console.log(`Trimming ${opts.src} — ${opts.mode === 'keep' ? 'keep' : 'remove'} gaussians inside the region…`);

trimPly(srcAbs, outAbs, opts, (i, n) => console.log(`  scanned ${fmt(i)} / ${fmt(n)} gaussians`))
    .then(({ kept, total }) => {
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`Done in ${secs}s — wrote ${opts.out}: kept ${fmt(kept)} of ${fmt(total)} (removed ${fmt(total - kept)})`);
        process.exit(0);
    })
    .catch((err) => {
        console.error(`Trim failed: ${err.message}`);
        process.exit(1);
    });
