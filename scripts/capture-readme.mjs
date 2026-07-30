// Captures README "in action" screenshots from a real workspace in a real
// Electron window (production boot, like capture-docs). Run via `npm run
// docs:readme` with SPLAT_WORKSPACE pointing at the workspace and README_SHOTS
// naming what to capture (JSON: [{project, match, out}] — project name, a
// substring of the splat's file-row text, and the output PNG basename).
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const shotsDir = path.join(repoRoot, 'docs', 'screenshots');
const WORKSPACE = process.env.SPLAT_WORKSPACE;
if (!WORKSPACE) {
    console.error('Set SPLAT_WORKSPACE to the workspace folder containing the projects to capture.');
    process.exit(1);
}
if (!process.env.README_SHOTS) {
    console.error('Set README_SHOTS to a JSON list of shots, e.g. ' +
        '[{"project":"MyScan","match":"scene.ply","out":"readme-myscan"}]');
    process.exit(1);
}
const W = 1500, H = 950;

const SHOTS = JSON.parse(process.env.README_SHOTS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve, reject) => {
    const srv = createServer(); srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const waitForHealth = (port, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => { res.resume(); res.statusCode === 200 ? resolve() : retry(); });
        req.on('error', retry);
        req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => (Date.now() > deadline ? reject(new Error('server not ready')) : setTimeout(attempt, 250));
    attempt();
});

// spawn the API server on the real workspace being captured
const startServer = async (port) => {
    const env = { ...process.env, API_PORT: String(port), SPLAT_WORKSPACE: WORKSPACE };
    delete env.ELECTRON_RUN_AS_NODE;
    const proc = spawn(process.env.SPLAT_NODE_BIN || 'node', [path.join(repoRoot, 'server', 'index.mjs')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env });
    proc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    await waitForHealth(port);
    return proc;
};

// boot server + window, then capture each configured shot
async function run() {
    const port = await freePort();
    const server = await startServer(port);
    await fsp.mkdir(shotsDir, { recursive: true });

    const win = new BrowserWindow({ width: W, height: H, show: true, frame: false, backgroundColor: '#14161a', alwaysOnTop: true, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.setPosition(40, 40); win.setAlwaysOnTop(true, 'screen-saver');
    await win.loadURL(`http://127.0.0.1:${port}/`);
    win.show(); win.moveTop(); win.focus();

    const js = (code) => win.webContents.executeJavaScript(code, true);
    for (let i = 0; i < 80; i++) { if (await js('!!window.__viewer')) break; await sleep(150); }
    await sleep(500);

    const paintTick = () => js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))`);
    const shot = async (name) => {
        let img;
        for (let i = 0; i < 6; i++) { win.moveTop(); await paintTick(); await sleep(250); img = await win.webContents.capturePage(); if (!img.isEmpty() && img.getSize().width > 0) break; }
        const file = path.join(shotsDir, name + '.png');
        await fsp.writeFile(file, img.toPNG());
        console.log(`  ✓ ${name}.png (${Math.round(img.toPNG().length / 1024)} KB)`);
    };

    for (const s of SHOTS) {
        // switch project (reloads the file list, clears the viewport)
        await js(`(function(){var sel=document.getElementById('project-select'); sel.value=${JSON.stringify(s.project)}; sel.dispatchEvent(new Event('change',{bubbles:true})); return sel.value;})()`);
        await sleep(1800);
        // view the splat
        const found = await js(`(function(){var lis=[...document.querySelectorAll('#file-list li')]; var t=lis.find(function(x){return x.textContent.indexOf(${JSON.stringify(s.match)})>=0}); if(!t)return false; var v=[...t.querySelectorAll('button')].find(function(b){return /view/i.test(b.textContent)}); if(v)v.click(); return true;})()`);
        if (!found) { console.error(`  ✗ ${s.out}: ${s.match} not found in ${s.project}`); continue; }
        for (let i = 0; i < 160; i++) { if (await js('!!(window.__viewer&&window.__viewer.splatEntity&&window.__viewer.splatEntity.gsplat&&window.__viewer.splatEntity.gsplat.customAabb)')) break; await sleep(250); }
        await sleep(2500);
        await js(`window.__viewer&&window.__viewer.frame&&window.__viewer.frame()`);
        await sleep(1000);
        await shot(s.out);
    }

    server.kill();
    setTimeout(() => app.exit(0), 500);
}

app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1); });
setTimeout(() => { console.error('readme capture timed out'); app.exit(1); }, 180000);
