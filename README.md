# Splat Studio

<!-- versions: kept in sync by the weekly dependency-update routine -->
**Built with PlayCanvas `2.19.6` · @playcanvas/splat-transform `2.5.2`**

A local GUI for [`@playcanvas/splat-transform`](https://github.com/playcanvas/splat-transform):
splat format conversion, SOG bundling and collision-mesh generation, with a PlayCanvas
3D viewer — all in a dockable, Unity/Unreal-style tab editor you can rearrange and
save per workspace.

![Splat Studio with the Acropolis scan](docs/screenshots/readme-acropolis.png)

> The dockable editor: panels and the 3D viewport are tabs you can move, resize, float,
> close, and reopen from the **Window** menu — the layout is saved per workspace. Above:
> the Acropolis scan; below: HOTP.

![Splat Studio with the HOTP scan](docs/screenshots/readme-hotp.png)

📖 **[User Guide](docs/USER_GUIDE.md)** (illustrated, every feature) ·
⚙️ **[Automation Architecture](docs/AUTOMATION.md)** (how the app keeps itself current)

## Stack

- **Backend** — Express server (`server/`) that spawns the `splat-transform` CLI
  (`--no-tty`) as job subprocesses and serves the `workspace/` directory.
  The CLI brings its own native WebGPU (Dawn) device for GPU stages.
- **Frontend** — Vite + TypeScript (`client/`), PlayCanvas engine 2.x for rendering.
  The splat loads via the `gsplat` asset type (`.ply`, `.compressed.ply`, `.sog`,
  unbundled `meta.json`); the collision `.collision.glb` loads via the `container`
  asset type and is drawn with `RENDERSTYLE_WIREFRAME` on the Immediate layer.

## Usage

```bash
npm install
npm run demo   # generates workspace/demo-room.ply (synthetic room scan)
npm run dev    # server on :5174, UI on http://localhost:5173
```

The workspace defaults to `./workspace`, but each **top-level subfolder of the
workspace is a project** (e.g. `HOTP/`, `Acropolis/`). Point the workspace at a
folder of asset folders with the `SPLAT_WORKSPACE` env var (set in `dev.cmd`).
Within a project, sources can be nested (e.g. `RAW SOG/scene_10mil.sog`); the
file list surfaces every source individually but collapses output bundles
(streamed LOD, unbundled SOG) to their `lod-meta.json` / `meta.json` entry
point. Generated outputs always land at the project root.

Then in the browser:

0. **Project picker** (header) — switch projects (filters everything below and
   clears the viewport) or **+ New** to create one. Project scoping is
   per-request, so two windows can sit on different projects at once.
1. **Files** — drop a `.ply` / `.sog` / `.spz` / `.splat` / `.ksplat` file
   anywhere in the window (or use the generated `demo-room.ply`). Click
   **view** to display a splat; **✕** asks twice before deleting. Uploads show
   a progress bar; job outputs flash blue in the list. Panel headers
   collapse/expand on click (state persists), the Job panel stays pinned to
   the bottom of the sidebar, and all form values survive a reload.
2. **Convert** — pick an output format. SOG bundling is filename-driven in
   splat-transform: *SOG (bundled)* writes `name.sog`, *SOG (unbundled)* writes
   `name-sog/meta.json` + WebP textures. SH compression iterations apply to both.
   *Streamed LOD SOG* writes `name-lod/lod-meta.json` plus one unbundled-SOG
   chunk folder per LOD level, spatially chunked (`-C` K-gaussians per chunk,
   `-X` meters per chunk). The viewer streams chunks by camera distance — this
   is the format for big scenes in the PlayCanvas engine. Two source modes:
   - *Decimate input automatically* — the input is read once per level,
     GPU-decimated to `keep%^level` of the original and tagged `-l <n>`.
   - *Combine existing files as levels* — for pre-authored detail chains
     (e.g. exports at 20M/10M/4M/2M gaussians): the Input is LOD 0 and each
     added row is the next, lighter level; no decimation is performed.
3. **Collision** — voxelizes the splat (`name.voxel.json`/`.bin`) and emits a
   triangle mesh `name.collision.glb` (`-K smooth|faces`). Presets:
   - *Indoor* — `--voxel-external-fill` seals the room from outside, `--voxel-carve`
     re-opens the walkable interior from the seed.
   - *Outdoor* — `--voxel-floor-fill` closes holes in terrain.
   - *Object* — plain voxelization.

   The **seed position is in splat-transform's voxel space** (Y-up, but rotated
   180° about Y relative to the viewer — splat-transform maps raw splat space
   with `x,y → -x,-y` while viewers rotate about X). The 📷 button takes the
   current camera position and converts it for you (for the demo room, 1 m
   above the floor is `0, 1, 0`).
4. **Viewer** — toggle splat/collision/voxels, wire and voxel color/opacity,
   and *Frame scene*. Camera: orbit/pan with the mouse, fly with WASD.
   Generated collision results auto-load when the job finishes. Each loaded
   layer shows a HUD chip; the chip's **✕ unloads** that layer (frees its GPU
   memory — distinct from the show/hide checkboxes, which only toggle
   visibility), and **Clear viewport** unloads all three at once. **Collision
   style** offers X-ray wireframe (small meshes), hidden-line wireframe (a
   depth-only prepass culls hidden edges — dense meshes auto-switch to this
   above 100K triangles), and *Solid + edges* (lit translucent surface — the
   mode for verifying placement against the splat and flying inside carved
   interiors).
   Clicking **view** on a `.voxel.json` renders the sparse voxel octree as
   hardware-instanced translucent boxes (solid octree regions render as one
   merged box; display is capped at 1.5 M boxes — regenerate with a coarser
   voxel size if truncated). The `.voxel.bin` format is parsed client-side
   ([client/src/voxel-parser.js](client/src/voxel-parser.js), format
   documented in its header; validated against real output by
   `node scripts/test-voxel-parse.mjs <name>`).

## Analyze & procedural generators

- **Analyze** panel — pick any splat and **Summarize stats** (`-m/--summary`,
  `null` output, writes nothing). Results render as a **persistent card**:
  headline tiles (gaussian count, X×Y×Z extent, a NaN/Inf flag) over a per-column
  table with histograms, with a **copy** button for the raw Markdown. The card
  survives later jobs (unlike the transient Job log).
- **`.mjs` generators** — a JavaScript module that procedurally synthesizes a
  splat is a first-class Convert/Analyze input. Drop one in or click **+ sample
  generator** (writes [`examples/gen-grid.mjs`](examples/gen-grid.mjs)), then pick
  it as the Convert input. A generator must `export` a `Generator` class with a
  static `create(params)` returning `{ count, columnNames, getRow(index, row) }`;
  column values are raw (log-space scale, logit opacity, SH-DC colour). Local-only.
  - **Generator params** (`-p/--params`): pass `width=16,height=16,scale=4`. If
    the generator advertises a static `params` schema (`[{name,label,min,max,step,
    default}]`), the GUI renders **live sliders** instead of the freeform field.
  - **✨ Generate & view** runs the generator and loads the result straight into
    the 3D viewer in one click; releasing a slider regenerates and re-previews.
- **Bounds** (Viewer panel) — overlay the loaded splat's axis-aligned bounding
  box; its extent and any floaters/outliers (which stretch the box) show at a
  glance.

## Render to image (WebP) & output options

- **WebP render** — pick *WebP image (render)* as the Convert format to rasterize
  the splat to a lossless `.webp` via the GPU (`--camera`/`--look-at`/`--fov`/
  `--resolution`/`--background`). **📷 from viewer** seeds the camera from the 3D
  view. **Projection** switches pinhole ↔ equirectangular 360° panorama. **Depth
  of field** (`--f-stop`/`--focus-distance`, pinhole only) and **motion blur**
  (`--camera-end`/`--shutter`/`--motion-samples`) are exposed too.
- **Device** dropdown — choose the GPU adapter (listed via `-L/--list-gpus`) or
  CPU (`-g`). **Verbose** adds `--verbose --mem` diagnostics to the Job log.
- **HTML viewer** output gains **Unbundled** (`-U`, separate files) and a
  **Viewer settings** JSON (`-E`). An **.lcc** input gains **LOD levels** (`-O`).

## Edit: measure-to-scale & set origin

The **Edit** panel drives splat-transform from the viewport — splats have no
inherent scale or origin, so these fix both visually:

- **Measure → scale** — turn on *Measure mode* to drop two draggable markers
  (A green, B orange); drag each onto the ends of a feature whose real size you
  know (a doorway, a 1 m scale bar). The live readout shows the A–B distance;
  type the real length and **Apply scale** writes a correctly-scaled splat
  (`-s/--scale`) that auto-loads.
- **Set origin** — turn on *Pick origin*, drag the marker to the point that
  should be `(0,0,0)`, and **Set as origin** recenters the splat
  (`-t/--translate`) — handy before placing it in a scene.

Both write a new splat and load it straight into the viewer.

## Desktop app (standalone)

Splat Studio also ships as a self-contained Windows desktop app (Electron) — no
Node install, terminal, or `npm run dev` required. The Electron main process
([electron/main.mjs](electron/main.mjs)) picks a free port, launches the Express
server (the Electron binary runs as Node via `ELECTRON_RUN_AS_NODE`, so it can
still spawn the native-WebGPU `splat-transform` CLI), waits for it to come up,
then opens the UI in a Chromium window.

```bash
npm install
npm run make-icon   # regenerate build/icon.ico (committed; only needed if changed)
npm run dist:win    # build dist/ and package to release/
```

`release/` then contains:

- **`Splat Studio Setup <version>.exe`** — NSIS installer (per-user, lets you
  choose the install dir, creates Start-menu/desktop shortcuts).
- **`SplatStudio-<version>-portable.exe`** — single self-contained exe; run it
  from anywhere, nothing is installed.

`npm run pack:dir` produces an unpacked `release/win-unpacked/Splat Studio.exe`
for a quick smoke test without building the installers.

On first run the workspace defaults to `Documents\Splat Studio`; **File → Change
Workspace Folder…** points it at any folder of project subfolders (the choice is
remembered). **File → Open Workspace in Explorer** reveals it on disk.

## Notes

- **GPU required** for voxelization/collision and `--filter-cluster` (the CLI uses
  native WebGPU). SOG compression can fall back to CPU ("CPU only" checkbox,
  5–10× slower).
- The API binds to `127.0.0.1` only (it can write/delete files and spawn
  processes). A job is killed only after **10 minutes with no output** (an idle
  watchdog, not a wall-clock cap — a streamed-LOD bake on a large scene runs
  well over an hour while emitting a chunk every few seconds, and must not be
  reaped). Override with `SPLAT_JOB_IDLE_TIMEOUT_MS`. A running job can be
  cancelled from the job panel. Uploads are capped at 8 GB and written via temp
  file + rename so aborted uploads leave nothing behind.
- Convert jobs never overwrite a pre-existing file the app didn't generate —
  outputs divert to a `-converted` name instead (e.g. converting
  `room.compressed.ply` back to PLY won't clobber your original `room.ply`).
- The splat renders with the conventional 180° X flip (PLY data is Y-down);
  splat-transform's collision GLB is Y-up via a 180° Z rotation instead, so the
  viewer applies a 180° Y rotation to it — verified with an asymmetric test
  blob (`scripts/axis-test.mjs`). *Flip collision* removes that rotation for
  meshes from tools that already match viewer space.
- Workspace files live in `workspace/` (gitignored). The job log panel shows the
  exact CLI invocation for reproducing outside the GUI.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/files` | list workspace files |
| `POST /api/upload?name=` | upload (raw body stream) |
| `DELETE /api/files/:name` | delete file (folder for unbundled SOG) |
| `POST /api/convert` | `{ input, format, options }` → `{ jobId }` |
| `POST /api/collision` | `{ input, options }` → `{ jobId }` |
| `GET /api/jobs/:id` | job status, log, outputs |
| `POST /api/jobs/:id/cancel` | kill a running job |
| `GET /files/*` | static workspace files |
