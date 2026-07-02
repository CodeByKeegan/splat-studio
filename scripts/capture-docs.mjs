// Captures the annotated documentation screenshots in docs/screenshots/.
//
// Runs as an Electron main process (`npm run docs:capture`). It boots the real
// embedded server against a throwaway workspace seeded with the synthetic
// demo-room splat, opens the packaged UI in a BrowserWindow, drives each panel,
// draws a highlight over the controls being documented, and saves a full-window
// PNG. Because this is a real Electron window the 3D viewport renders normally,
// so the viewport screenshots show the actual splat.
//
// The doc-refresh loop runs this after any app/dependency change so the guide's
// images never drift from the UI. Re-running overwrites the PNGs in place.
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const shotsDir = path.join(repoRoot, 'docs', 'screenshots');
const captureWs = path.join(repoRoot, 'docs', '.capture-workspace');
const demoSrc = path.join(repoRoot, 'workspace', 'demo-room.ply');
const W = 1500, H = 950;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

const waitForHealth = (port, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
            res.resume();
            res.statusCode === 200 ? resolve() : retry();
        });
        req.on('error', retry);
        req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => (Date.now() > deadline ? reject(new Error('server not ready')) : setTimeout(attempt, 250));
    attempt();
});

// seed a clean workspace with one project ("Demo room") holding the demo splat
const seedWorkspace = () => {
    if (!fs.existsSync(demoSrc)) throw new Error('workspace/demo-room.ply missing — run `npm run demo` first');
    fs.rmSync(captureWs, { recursive: true, force: true });
    const proj = path.join(captureWs, 'Demo room');
    fs.mkdirSync(proj, { recursive: true });
    fs.copyFileSync(demoSrc, path.join(proj, 'demo-room.ply'));
};

const startServer = async (port) => {
    const env = { ...process.env, API_PORT: String(port), SPLAT_WORKSPACE: captureWs };
    delete env.ELECTRON_RUN_AS_NODE;
    const proc = spawn(process.env.SPLAT_NODE_BIN || 'node', [path.join(repoRoot, 'server', 'index.mjs')], {
        cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env
    });
    proc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    await waitForHealth(port);
    return proc;
};

// ---------- in-page helpers (injected once) ----------
// highlight: outline + glow over each selector, with optional numbered badges
const PAGE_HELPERS = `
window.__doc = {
  clearHl() { document.querySelectorAll('.__doc-hl,.__doc-badge').forEach(n => n.remove()); },
  clear() { this.clearHl(); document.querySelectorAll('.ctx-menu').forEach(n => n.remove()); document.querySelectorAll('.menu-drop').forEach(d => d.classList.add('hidden')); window.__settings && window.__settings.close(); },
  closeMenus() { document.querySelectorAll('.menu-drop').forEach(d => d.classList.add('hidden')); },
  hl(selectors, opts) {
    opts = opts || {};
    this.clearHl(); // highlights only — must not dismiss the menu/dialog being captured
    const sels = Array.isArray(selectors) ? selectors : [selectors];
    sels.forEach((sel, i) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const pad = opts.pad == null ? 4 : opts.pad;
      const box = document.createElement('div');
      box.className = '__doc-hl';
      Object.assign(box.style, {
        position: 'fixed', left: (r.left - pad) + 'px', top: (r.top - pad) + 'px',
        width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px',
        border: '2.5px solid #ffcf4d', borderRadius: '7px',
        boxShadow: '0 0 0 2px rgba(255,207,77,.35), 0 0 16px 3px rgba(255,207,77,.45)',
        pointerEvents: 'none', zIndex: 99998
      });
      document.body.appendChild(box);
      if (opts.numbered) {
        const b = document.createElement('div');
        b.className = '__doc-badge'; b.textContent = String(i + 1);
        // keep the badge clear of the icon rail (~44px) so it is never clipped
        const bx = Math.max(r.left - pad - 11, 46);
        Object.assign(b.style, {
          position: 'fixed', left: bx + 'px', top: (r.top - pad - 11) + 'px',
          width: '22px', height: '22px', borderRadius: '50%', background: '#ffcf4d', color: '#1a1205',
          font: '700 13px Segoe UI, sans-serif', display: 'grid', placeItems: 'center',
          boxShadow: '0 2px 6px rgba(0,0,0,.5)', pointerEvents: 'none', zIndex: 99999
        });
        document.body.appendChild(b);
      }
    });
    return sels.length;
  },
  // focus a panel's dock tab (replaces the old icon rail). panel = the dock id.
  rail(panel) {
    document.querySelectorAll('.menu-drop').forEach(d => d.classList.add('hidden')); // close any open menu
    const dock = window.__dock;
    if (!dock) return;
    if (!dock.getPanel(panel)) {
      const w = { 'panel-files':'Files','panel-convert':'Convert','panel-lod':'LOD','panel-render':'Render','panel-analyze':'Analyze','panel-edit':'Edit','panel-collision':'Collision','panel-scene':'Scene','camera-view':'Camera view' }[panel];
      try { dock.addPanel({ id: panel, component: panel, title: w || panel }); } catch (e) {}
    }
    const p = dock.getPanel(panel);
    if (p) p.api.setActive();
  }
};
true;
`;

async function run() {
    const port = await freePort();
    seedWorkspace();
    const server = await startServer(port);
    await fsp.mkdir(shotsDir, { recursive: true });

    const win = new BrowserWindow({
        width: W, height: H, show: true, frame: false,
        backgroundColor: '#14161a', alwaysOnTop: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    win.setPosition(40, 40);
    win.setAlwaysOnTop(true, 'screen-saver');
    await win.loadURL(`http://127.0.0.1:${port}/`);
    win.show();
    win.moveTop();
    win.focus();

    const js = (code) => win.webContents.executeJavaScript(code, true);
    // wait for the viewer to come up
    for (let i = 0; i < 80; i++) { if (await js('!!window.__viewer')) break; await sleep(150); }
    await js(PAGE_HELPERS);
    await sleep(400);

    // wait for an actual rendered frame, then capture; retry while the
    // compositor hands back an empty image (window not yet painted/foreground)
    const paintTick = () => js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))`);
    const shot = async (name) => {
        let img;
        for (let i = 0; i < 6; i++) {
            win.moveTop();
            await paintTick();
            await sleep(250);
            img = await win.webContents.capturePage();
            if (!img.isEmpty() && img.getSize().width > 0) break;
        }
        const file = path.join(shotsDir, name + '.png');
        const buf = img.toPNG();
        await fsp.writeFile(file, buf);
        console.log(`  ${buf.length > 0 ? '✓' : '✗'} ${name}.png (${Math.round(buf.length / 1024)} KB, ${img.getSize().width}x${img.getSize().height})`);
        return buf.length;
    };

    // load the demo splat into the viewer (real window → viewport renders)
    await js(`(function(){var li=[...document.querySelectorAll('#file-list li')].find(x=>x.textContent.includes('demo-room'));if(li){var v=[...li.querySelectorAll('button')].find(b=>/view/i.test(b.textContent));v&&v.click();}return true;})()`);
    for (let i = 0; i < 80; i++) {
        if (await js('!!(window.__viewer&&window.__viewer.splatEntity&&window.__viewer.splatEntity.gsplat&&window.__viewer.splatEntity.gsplat.customAabb)')) break;
        await sleep(200);
    }
    await sleep(1200); // let the camera frame and a few frames render

    // ----- scenes -----
    const scenes = [];
    const add = (name, fn) => scenes.push({ name, fn });

    add('app-overview', async () => { await js(`window.__doc.clear()`); });
    add('editor-chrome', async () => { await js(`window.__doc.hl(['#app-brand','#menubar','#project-bar'],{numbered:true,pad:3});`); });
    add('window-menu', async () => {
        await js(`window.__doc.clear(); var b=[...document.querySelectorAll('#menubar .menu-btn')].find(x=>x.textContent==='Window'); if(b)b.click();`);
        await sleep(200);
        await js(`var d=document.querySelector('#menubar .menu-drop:not(.hidden)'); window.__doc.hl(d?[d]:['#menubar'],{});`);
    });
    add('files-panel', async () => { await js(`window.__doc.clear(); window.__doc.rail('panel-files'); window.__doc.hl(['#drop-zone','#file-list'],{numbered:true});`); });
    // right-click (context) menu of per-file actions: open it on the demo splat row
    add('files-context-menu', async () => {
        await js(`window.__doc.clear(); window.__doc.rail('panel-files');`);
        await sleep(150);
        await js(`(function(){var li=[...document.querySelectorAll('#file-list li')].find(x=>x.textContent.includes('demo-room'));if(!li)return false;var r=li.getBoundingClientRect();li.dispatchEvent(new MouseEvent('contextmenu',{clientX:Math.round(r.left+60),clientY:Math.round(r.top+12),bubbles:true,cancelable:true}));return true;})()`);
        await sleep(200);
        await js(`var m=document.querySelector('.ctx-menu'); window.__doc.hl(m?[m]:['#file-list'],{pad:3});`);
    });
    add('convert-formats', async () => { await js(`window.__doc.clear(); window.__doc.rail('panel-convert'); var f=document.getElementById('convert-format'); f.value='sog'; f.dispatchEvent(new Event('change',{bubbles:true})); window.__doc.hl(['#convert-input','#convert-format'],{numbered:true});`); });
    // transforms now live in the Edit panel (Convert is format + filters only):
    // one clean box around the whole Transform group (header → Apply transform)
    add('edit-transform', async () => {
        await js(`window.__doc.clear(); window.__doc.rail('panel-scene'); window.__doc.rail('panel-edit');`);
        await sleep(200);
        await js(`(function(){window.__doc.clear();var hdr=[...document.querySelectorAll('#panel-edit .group')].find(e=>/^transform/i.test(e.textContent.trim())),btn=document.getElementById('apply-transform');if(!hdr||!btn){window.__doc.hl(['#apply-transform'],{});return;}var a=hdr.getBoundingClientRect(),b=btn.getBoundingClientRect(),pad=5,left=Math.min(a.left,b.left)-pad,top=a.top-pad,right=Math.max(a.right,b.right)+pad,bottom=b.bottom+pad,box=document.createElement('div');box.className='__doc-hl';Object.assign(box.style,{position:'fixed',left:left+'px',top:top+'px',width:(right-left)+'px',height:(bottom-top)+'px',border:'2.5px solid #ffcf4d',borderRadius:'7px',boxShadow:'0 0 0 2px rgba(255,207,77,.35), 0 0 16px 3px rgba(255,207,77,.45)',pointerEvents:'none',zIndex:'99998'});document.body.appendChild(box);})();`);
    });
    // WebP rendering is its own Render tab — settle the layout before highlighting
    add('render-tab', async () => {
        await js(`window.__doc.clear(); window.__doc.rail('panel-scene'); window.__doc.rail('panel-render'); var ri=document.getElementById('render-input'); if(ri){ri.value='demo-room.ply'; ri.dispatchEvent(new Event('change',{bubbles:true}));}`);
        await sleep(350);
        await js(`var p=document.getElementById('panel-render'); if(p) p.scrollTop=0; window.__doc.hl(['#render-input','#webp-camera','#render-run'],{numbered:true});`);
        await sleep(150);
    });
    add('analyze-panel', async () => { await js(`var f=document.getElementById('convert-format'); f.value='sog'; f.dispatchEvent(new Event('change',{bubbles:true})); window.__doc.rail('panel-analyze'); window.__doc.hl('#panel-analyze');`); });
    add('collision-panel', async () => { await js(`window.__doc.rail('panel-collision'); window.__doc.hl('#panel-collision');`); });
    add('viewport-toolbar', async () => { await js(`window.__doc.clear(); window.__doc.rail('panel-files'); window.__doc.hl('#viewport-toolbar',{pad:3});`); });
    add('settings-panel', async () => {
        await js(`window.__doc.clear(); window.__settings.open('appearance');`);
        await sleep(250);
        await js(`window.__doc.hl('#settings-modal',{pad:5});`);
    });

    // scene hierarchy: keep the Collision tab active + carve on (so the capsule
    // qualifies), webp on (so the render camera lists), then select the capsule
    add('scene-hierarchy', async () => {
        await js(`var f=document.getElementById('convert-format'); f.value='webp'; f.dispatchEvent(new Event('change',{bubbles:true}));
            window.__doc.rail('panel-collision');
            var cv=document.getElementById('carve'); if(!cv.checked){cv.checked=true; cv.dispatchEvent(new Event('change',{bubbles:true}));}
            window.__doc.rail('panel-scene');`);
        await sleep(200);
        await js(`(function(){var rows=[...document.querySelectorAll('#scene-list .scene-item')];var cap=rows.find(r=>/capsule/i.test(r.textContent));if(cap)cap.click();return true;})()`);
        await sleep(300);
        await js(`window.__doc.hl('#scene-list',{});`);
    });

    // live camera view: open the panel, WebP on, aim the render camera at the splat
    add('camera-view', async () => {
        await js(`window.__doc.clear();
            var f=document.getElementById('convert-format'); f.value='webp'; f.dispatchEvent(new Event('change',{bubbles:true}));
            window.__doc.rail('camera-view');
            (function(){var v=window.__viewer; if(!v||!v.splatEntity)return; var a=v.splatEntity.gsplat.customAabb, wt=v.splatEntity.getWorldTransform(); var C=wt.transformPoint(a.center.clone()), r=a.halfExtents.length(); v.camera.setPosition(C.x+r*1.1,C.y+r*0.6,C.z+r*1.1); v.camera.lookAt(C); var p=v.cameraRenderPose(); document.getElementById('webp-camera').value=p.camera; document.getElementById('webp-lookat').value=p.lookAt; document.getElementById('convert-format').dispatchEvent(new Event('change',{bubbles:true}));})();`);
        await sleep(1200); // let the render-to-texture readback fill the preview
        await js(`var c=document.querySelector('.camera-view-canvas'); window.__doc.hl(c?[c]:['.camera-view-panel'],{});`);
    });

    // measure mode: place two points on the demo splat, then highlight the
    // (non-adjacent) controls so the numbered badges never crowd each other
    add('edit-measure', async () => {
        await js(`var f=document.getElementById('convert-format'); f.value='sog'; f.dispatchEvent(new Event('change',{bubbles:true}));`);
        await js(`window.__doc.rail('panel-edit');`);
        await js(`var mt=document.getElementById('measure-toggle'); if(!mt.checked){mt.checked=true; mt.dispatchEvent(new Event('change',{bubbles:true}));}`);
        await sleep(200);
        await js(`(function(){
            var v=window.__viewer, app=v.app, c=app.graphicsDevice.canvas, r=c.getBoundingClientRect();
            function click(fx,fy){var x=r.left+r.width*fx,y=r.top+r.height*fy;
              c.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,button:0,bubbles:true}));
              c.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,button:0,bubbles:true}));}
            click(0.46,0.5); click(0.6,0.62); return true; })()`);
        await sleep(300);
        await js(`window.__doc.hl(['#measure-toggle','#measure-edit-row','#apply-scale'],{numbered:true});`);
    });

    // carve out a region (Edit panel): box on over the splat + live count, scrolled in
    add('trim-carve', async () => {
        await js(`window.__doc.clear();`);
        // load the demo splat so the carve box previews against it
        await js(`(function(){var li=[...document.querySelectorAll('#file-list li')].find(x=>x.textContent.includes('demo-room.ply'));if(li){var v=[...li.querySelectorAll('button')].find(b=>/view/i.test(b.textContent));v&&v.click();}return true;})()`);
        await sleep(1300);
        await js(`window.__doc.rail('panel-scene'); window.__doc.rail('panel-edit');
            var mt=document.getElementById('measure-toggle'); if(mt.checked){mt.checked=false; mt.dispatchEvent(new Event('change',{bubbles:true}));}
            var ei=document.getElementById('edit-input'); ei.value='demo-room.ply'; ei.dispatchEvent(new Event('change',{bubbles:true}));
            var cb=document.getElementById('carve-box-on'); if(!cb.checked){cb.checked=true; cb.dispatchEvent(new Event('change',{bubbles:true}));}
            var bx=document.getElementById('carve-box-min-x'); bx.value='-1'; bx.dispatchEvent(new Event('input',{bubbles:true}));`);
        await sleep(600); // box shows + the debounced count computes
        await js(`document.getElementById('carve-remove').scrollIntoView({block:'center'});`);
        await sleep(250);
        await js(`window.__doc.hl(['#region-mode','#carve-box-rows','#carve-count','#carve-remove'],{});`);
    });

    // LOD auto-tune: seed a few copies (one a 'sky' backdrop), combine mode, auto-tune
    add('lod-autotune', async () => {
        await js(`window.__doc.clear();`);
        await js(`(async function(){
            var blob = await (await fetch('/files/Demo%20room/demo-room.ply')).blob();
            async function up(n){ await fetch('/api/upload?project=Demo%20room&name='+encodeURIComponent(n),{method:'POST',body:blob}); }
            await up('scene-mid.ply'); await up('scene-low.ply'); await up('sky.ply'); return true;
        })()`);
        await sleep(400);
        await js(`(function(){var ps=document.getElementById('project-select'); ps.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await sleep(700);
        await js(`window.__doc.rail('panel-lod');
            var li=document.getElementById('lod-input'); li.value='demo-room.ply'; li.dispatchEvent(new Event('change',{bubbles:true}));
            var m=document.getElementById('lod-mode'); m.value='combine'; m.dispatchEvent(new Event('change',{bubbles:true}));
            document.getElementById('lod-file-rows').innerHTML='';
            var add=document.getElementById('lod-add-level'); add.click(); add.click(); add.click();
            var names=['scene-mid.ply','scene-low.ply','sky.ply'];
            [...document.querySelectorAll('#lod-file-rows .lod-row')].forEach(function(r,i){var s=r.querySelector('select'); if(names[i]){s.value=names[i]; s.dispatchEvent(new Event('change',{bubbles:true}));}});`);
        await sleep(200);
        await js(`document.getElementById('lod-autotune').click();`);
        await js(`new Promise(function(res){var t=Date.now();(function p(){var el=document.getElementById('lod-autotune-plan'); if(el && !el.classList.contains('hidden') && el.textContent.trim()) return res(true); if(Date.now()-t>9000) return res(false); setTimeout(p,200);})();})`);
        await sleep(300);
        await js(`window.__doc.rail('panel-scene');`); // clean right side (avoid the stale Camera view render)
        await sleep(150);
        // plain glow on the auto-tune button + the ordered rows (no numbered badges to overlap)
        await js(`window.__doc.hl(['#lod-autotune','#row-lod-files'],{});`);
    });

    // linked group (Files panel): set a transform on the proxy in the Edit panel,
    // tick members in Files, apply the transform to all
    add('linked-group', async () => {
        await js(`window.__doc.clear(); window.__doc.rail('panel-edit');
            var ei=document.getElementById('edit-input'); ei.value='demo-room.ply'; ei.dispatchEvent(new Event('change',{bubbles:true}));
            var f=document.getElementById('convert-format'); f.value='ply'; f.dispatchEvent(new Event('change',{bubbles:true}));
            var tx=document.getElementById('tf-translate-x'); tx.value='1'; tx.dispatchEvent(new Event('input',{bubbles:true})); tx.dispatchEvent(new Event('change',{bubbles:true}));`);
        await sleep(150);
        await js(`window.__doc.rail('panel-scene'); window.__doc.rail('panel-files');
            var want=['demo-room.ply','scene-mid.ply'];
            [...document.querySelectorAll('#group-members input[type=checkbox]')].forEach(function(cb){ if(want.indexOf(cb.value)>=0 && !cb.checked){cb.checked=true; cb.dispatchEvent(new Event('change',{bubbles:true}));} });`);
        await sleep(300);
        await js(`window.confirm=function(){return true;}; document.getElementById('group-apply').click();`);
        await js(`new Promise(function(res){var t=Date.now();(function p(){var st=document.getElementById('job-status'), ti=document.getElementById('job-title'); if(st && ti && /done/.test(st.textContent) && /scene-mid/.test(ti.textContent)) return res(true); if(Date.now()-t>20000) return res(false); setTimeout(p,300);})();})`);
        await js(`document.getElementById('group-actions').scrollIntoView({block:'center'});`);
        await sleep(700);
        await js(`window.__doc.hl(['#group-members','#group-apply'],{numbered:true});`);
    });

    // carve propagation: set a Region on the proxy (Edit), tick members in Files,
    // then 'Apply region to members' fans the carve/crop to every LOD
    add('group-region', async () => {
        await js(`window.__doc.clear(); window.__doc.rail('panel-edit');
            var ei=document.getElementById('edit-input'); ei.value='demo-room.ply'; ei.dispatchEvent(new Event('change',{bubbles:true}));
            var cb=document.getElementById('carve-box-on'); if(!cb.checked){cb.checked=true; cb.dispatchEvent(new Event('change',{bubbles:true}));}
            var bx=document.getElementById('carve-box-min-x'); bx.value='-1'; bx.dispatchEvent(new Event('input',{bubbles:true}));`);
        await sleep(300);
        await js(`window.__doc.rail('panel-files');
            var want=['demo-room.ply','scene-mid.ply'];
            [...document.querySelectorAll('#group-members input[type=checkbox]')].forEach(function(cb){ if(want.indexOf(cb.value)>=0 && !cb.checked){cb.checked=true; cb.dispatchEvent(new Event('change',{bubbles:true}));} });`);
        await sleep(300);
        await js(`document.getElementById('group-actions').scrollIntoView({block:'center'});`);
        await sleep(300);
        await js(`window.__doc.hl(['#group-members','#group-apply-region'],{numbered:true});`);
    });

    // SCENES=a,b limits a run to specific scenes (faster doc iteration; others keep their last shot)
    const only = (process.env.SCENES || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of scenes) {
        if (only.length && !only.includes(s.name)) continue;
        try { await s.fn(); await shot(s.name); }
        catch (e) { console.error(`  ✗ ${s.name}: ${e.message}`); }
    }
    await js(`window.__doc.clear()`);

    server.kill();
    setTimeout(() => app.exit(0), 500);
}

app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1); });
// safety net: never hang the loop
setTimeout(() => { console.error('capture timed out'); app.exit(1); }, 120000);
