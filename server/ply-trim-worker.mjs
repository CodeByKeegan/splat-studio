// Trim worker — spawned as a job (process.execPath ply-trim-worker.mjs <json>),
// so it slots into the existing job system (log streaming, idle watchdog, output
// detection + autoload) with no special handling. Paths are project-relative and
// resolved against cwd (the job's project dir). Progress lines keep the watchdog
// armed on big files.
//
// PLY inputs are trimmed directly. Other single-file splats (.sog/.spz/.splat/…)
// are first decompressed to a temp PLY via the splat-transform CLI (process.execPath
// is a real Node binary in every mode), then trimmed — so the output is always .ply.
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { trimPly } from './ply-trim.mjs';
import { cliPath } from './commands.mjs';

const opts = JSON.parse(process.argv[2] ?? '{}');
const cwd = process.cwd();
const rel = (p) => String(p).split('/').join(path.sep);
const srcAbs = path.resolve(cwd, rel(opts.src));
const outAbs = path.resolve(cwd, rel(opts.out));
const isPly = /\.ply$/i.test(String(opts.src));

const t0 = Date.now();
const fmt = (n) => n.toLocaleString();
const scan = (i, n) => console.log(`  scanned ${fmt(i)} / ${fmt(n)} gaussians`);

// run the splat-transform CLI to convert src -> dst (both relative to cwd)
const cliConvert = (src, dst) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--no-tty', '-w', src, dst], { cwd, windowsHide: true });
    let err = '';
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => { err += d.toString(); process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', (code) => code === 0
        ? resolve()
        : reject(new Error(`decompress ${src} → PLY exited ${code}${err ? `: ${err.trim().slice(-200)}` : ''}`)));
});

const report = (kept, total) => {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`Done in ${secs}s — wrote ${opts.out}: kept ${fmt(kept)} of ${fmt(total)} (removed ${fmt(total - kept)})`);
};

const main = async () => {
    const verb = opts.mode === 'keep' ? 'keep' : 'remove';
    if (isPly) {
        console.log(`Trimming ${opts.src} — ${verb} gaussians inside the region…`);
        const { kept, total } = await trimPly(srcAbs, outAbs, opts, scan);
        report(kept, total);
        return;
    }
    // non-PLY: decompress to a temp PLY (dotfile, hidden from the file list), trim it,
    // then drop the temp. The output is the trimmed .ply.
    const tmp = `.trim-${Date.now().toString(36)}.ply`;
    const tmpAbs = path.resolve(cwd, tmp);
    try {
        console.log(`Reading ${opts.src} → PLY for trimming…`);
        await cliConvert(opts.src, tmp);
        console.log(`Trimming — ${verb} gaussians inside the region…`);
        const { kept, total } = await trimPly(tmpAbs, outAbs, opts, scan);
        report(kept, total);
    } finally {
        await rm(tmpAbs, { force: true }).catch(() => { /* best-effort */ });
    }
};

main().then(() => process.exit(0)).catch((err) => {
    console.error(`Trim failed: ${err.message}`);
    process.exit(1);
});
