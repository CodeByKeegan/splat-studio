# Splat Studio MCP workflows — tutorials

Step-by-step recipes for driving Splat Studio through its MCP server — from everyday
conversions to the workflows you'd never guess existed. Each tutorial lists the exact
tool calls, what comes back, and the pitfalls.

**Before you start:** Splat Studio must be running and your MCP client connected — see
[MCP_SETUP.md](MCP_SETUP.md). Tutorials marked **(editor)** additionally need
**Settings → Agent control (MCP)** ticked in the app.

---

## The three things to know first

**1. Long operations are jobs.** `convert`, `build_lod`, `render_image`,
`generate_collision`, `trim_region`, and `get_summary` return `{ jobId }` immediately.
Always follow with:

```
jobs(action: "wait", id: <jobId>, timeout_ms: 300000)   → blocks until done/error
jobs(action: "get",  id: <jobId>)                        → full record: log, outputs, viewables
```

On `timeout` the job **keeps running server-side** — wait again or `cancel` it.

**2. Two coordinate frames.** The live viewport (`camera`, `viewport_click`, `measure`)
speaks **viewer-world**. The CLI pipeline (`convert` translate/rotate/filters,
`trim_region`, `render_image` cameras, `generate_collision` seed/region,
`render_pose`, `set_collision_gizmo`) speaks **CLI space** — same Y-up, but **x and z
are negated** relative to the viewer. Converting a viewer-world point `[x, y, z]` to
CLI space is just `[-x, y, -z]`.

**3. Errors are uniform.** Every failure is `{ error, message }` with `error` one of
`no-editor`, `control-disabled`, `bad-input`, `job-failed`, `not-found`, `timeout`,
`gpu-required`. Before any editor work, probe headlessly:

```
inspect(target: "editor_status")   → { connected, controlEnabled, ... }
```

---

## Common workflows

### 1. Import and inspect a splat

Bring a local file in, then find out what you're working with.

```
projects(action: "create", name: "My Scan")                       (skip if it exists)
import_file(project: "My Scan", source_path: "C:/scans/room.ply")
inspect(target: "stats", project: "My Scan", input: "room.ply")   → { count, extents }
get_summary(project: "My Scan", input: "room.ply")                → { jobId }
jobs(action: "wait", id: ...) then jobs(action: "get", id: ...)
```

The per-column stats table (mins/maxes/NaN counts per gaussian attribute) is in the
**job log**, not a file. Pitfalls: `import_file` **overwrites** an existing file with
the same name; project/file names allow only letters, digits, spaces, and `( ) . _ -`.

### 2. Convert to web-ready SOG

The bread-and-butter conversion — a compressed bundle any PlayCanvas app can stream.

```
convert(project: "My Scan", input: "room.ply", format: "sog")     → { jobId }
jobs(action: "wait", id: ...)                                     → outputs: room.compressed.ply-style bundle
```

Options worth reaching for: `iterations: 10` (SH-compression quality; higher = slower,
better), `device: "cpu"` if there's no GPU (SOG has a CPU fallback), `format:
"sog-unbundled"` for a folder of loose WebP files instead of one bundle.

### 3. Streamed LOD for big scenes

Over ~2M gaussians, a single SOG stalls the first paint. Bake a streamed multi-LOD
bundle instead — and let the server suggest the settings:

```
suggest_lod_settings(project: "City", input: "city.ply")
   → { suggestion: { mode, lodLevels, lodKeepPercent, lodChunkCount, lodChunkExtent }, rationale }
build_lod(project: "City", input: "city.ply", mode: "decimate", ...suggestion)
jobs(action: "wait", id: ..., timeout_ms: 1800000)                (big scenes take a while)
```

Output is a `lod-meta.json` bundle folder. Deleting that entry point via
`files(action: "delete")` removes the whole folder.

### 4. Collision mesh for a game engine

Voxelize the splat into `*.collision.glb` (plus voxel debug files). **GPU required.**

```
generate_collision(project: "My Scan", input: "room.ply",
                   voxelSize: 0.05, seedPos: [0, 1, 0],
                   carve: { height: 1.8, radius: 0.4 })
```

- `seedPos` is CLI space; `[0, 1, 0]` = 1 m above the floor at the origin — a good
  default for indoor scans. It seeds the flood fill that separates inside from outside.
- `carve` guarantees a player-capsule-sized tunnel stays open.
- **The preflight may refuse:** huge scene × fine voxel overflows the marching-cubes
  vertex limit. The refusal includes `{ preflight }` with the estimated load. Raise
  `voxelSize`, crop with `filterBox`/`filterSphere`, or (accepting the crash risk)
  pass `overridePreflight: true`.
- No GPU → `{ error: "gpu-required" }`.

### 5. Render a hero image

Offline WebP render with full camera control — no editor needed.

```
render_image(project: "My Scan", input: "room.ply", image: {
    camera: "3,1.6,-3", lookAt: "0,1,0", fov: 50,
    resolution: "1920x1080", background: "0.1,0.1,0.12"
})
```

Camera vectors are CLI-space `"x,y,z"` strings. For depth of field add
`fStop: 1.4, focusDistance: 4`. To *see* what the camera will frame before burning a
render, use the editor: `render_pose(action: "set", camera: [...], lookAt: [...])`
shows a frustum in the viewport, then `viewport_screenshot(max_width: 800)` to check.

### 6. Clean up a noisy capture

Raw scans come with floaters, NaN gaussians, and background junk.

```
convert(project: "My Scan", input: "room.ply", format: "ply",
        filterNaN: true, filterFloaters: {})
```

- `filterFloaters: {}` uses the CLI defaults (size 0.05 / opacity 0.1 / min 0.004) —
  it's **GPU-only**; on `gpu-required` fall back to
  `filterValue: { column: "opacity", comparator: "gt", value: 0.05 }`.
- Check the damage: `inspect(target: "stats")` before and after — count should drop,
  extents should tighten.
- There's a canned prompt for this: `clean_up_scan`.

### 7. Crop to a region / carve out junk

`trim_region` rewrites the splat with gaussians removed (`mode: "remove"`) or kept
(`mode: "keep"`) inside a box and/or sphere — the thing `-B`/`-S` filters can't do in
one step. Works on any single-file splat; non-PLY inputs are decompressed first,
output is always `.ply`.

```
trim_region(project: "My Scan", input: "room.ply", mode: "keep",
            box: [-5, "", -5, 5, "", 5])          ("" = that side unbounded)
```

Box/sphere are CLI space. To set the region visually first **(editor)**:
`set_region(target: "crop_box", box: [...])`, confirm with `viewport_screenshot`,
then run the trim headlessly with the same numbers.

---

## Uncommon workflows

### 8. 360° panorama render

Equirectangular render for VR viewers / skyboxes — one line of difference:

```
render_image(project: "My Scan", input: "room.ply", image: {
    projection: "equirect", camera: "0,1.6,0", resolution: "4096x2048"
})
```

`equirect` ignores `fov` and depth-of-field; `camera` is the pano's eye point. A 2:1
resolution keeps the projection undistorted. The output WebP drops straight into
Splat Studio's own skybox slot: `set_view_option(option: "skybox", value: "<file>")`.

### 9. Motion-blur render

Supply an end pose and the renderer integrates the camera path:

```
render_image(project: "My Scan", input: "room.ply", image: {
    camera: "3,1.6,-3",  lookAt: "0,1,0",
    cameraEnd: "2.6,1.6,-3.4", lookAtEnd: "0,1,0",
    shutter: 0.5, motionSamples: 64, resolution: "1920x1080"
})
```

`shutter` (0–1) is the exposure fraction of the move; more `motionSamples` = smoother
trails, linearly slower. Keep the move small — motion blur sells at 10–20 cm of travel.

### 10. Scale to real-world units *(editor)*

Photogrammetry splats are rarely metric. Measure a known span, then apply the scale:

```
inspect(target: "editor_status")                       → needs connected + controlEnabled
load_into_viewport(action: "load", project: "My Scan", file: "room.ply")
panel(action: "open", id: "panel-edit")
measure(action: "measure", points: [[a...], [b...]])   (or two viewport_click calls)
measure(action: "set_length", length: 0.82)            (the span's real size in meters)
measure(action: "measure")                             → { a, b, distance, scale }
convert(project: "My Scan", input: "room.ply", format: "ply", scale: <scale>)
```

The `scale` field is precomputed: real length ÷ measured span. Canned prompt:
`scale_to_real_world`.

### 11. Recenter the origin *(editor)*

Put the origin where the content actually is (engines expect it):

```
set_origin(point: [1.2, 0.0, -3.4])                    (viewer-world; or place via viewport_click)
   → { placed: true, translate: [x, y, z] }            (already CLI space)
convert(project: "My Scan", input: "room.ply", format: "ply", translate: <translate>)
```

### 12. Environment-shell LOD (combine mode)

For scenes with a hero object inside a big backdrop: keep the backdrop always visible
as a cheap shell while the subject streams in detail.

```
build_lod(project: "Museum", input: "statue-full.ply", mode: "combine",
          lodFiles: ["statue-half.ply", "hall-backdrop.ply"],
          lodEnvFlags: [false, true])
```

`input` is LOD 0 (finest). `lodFiles` are progressively lighter levels;
`lodEnvFlags[i]: true` marks that file as the always-visible environment (LOD −1).
At least one non-env level is required. Make the lighter levels first with
`convert(..., decimate: "50%")`.

### 13. Procedural splats from a generator

A `.mjs` generator is a script that synthesizes gaussians — useful for test patterns,
plinths, particle beds. Drop one in the project (see `examples/gen-grid.mjs`), then:

```
inspect(target: "generator_params", project: "Lab", input: "gen-grid.mjs")
   → its advertised params (the GUI shows these as sliders)
convert(project: "Lab", input: "gen-grid.mjs", format: "ply",
        params: "count=50000,size=2")
```

### 14. Data exports: CSV and a self-contained HTML viewer

```
convert(project: "My Scan", input: "room.ply", format: "csv")    → spreadsheet-ready gaussian table
convert(project: "My Scan", input: "room.ply", format: "html")   → single shareable HTML viewer
```

CSV gets you per-gaussian data for external analysis (opacity histograms, density
plots). The HTML export embeds everything — send it to someone with no tooling at all.
`format: "spz"` (Niantic) and `format: "glb"` (KHR_gaussian_splatting) cover engine
interchange; `spzVersion: 3` if the consumer is on the older spec.

### 15. Visual QA loop *(editor)*

Verify outputs by looking at them — the way a human would:

```
load_into_viewport(action: "load", project: "My Scan", file: "room.collision.glb")
set_view_option(option: "collision_style", value: "xray")
camera(action: "frame")
viewport_screenshot(max_width: 1024)          → image comes back inline
history(action: "undo")                        (roll back a form/view misstep)
```

Screenshots default to full viewport resolution (≤1920); pass `max_width` for cheaper
quick looks. `history` undoes form fields, loaded-splat, and layer-visibility changes —
**not** job outputs or file deletes.

### 16. Batch pipeline across a whole workspace

Chain everything headlessly — e.g. "make every raw scan web-ready":

```
workspace(action: "get")                              → { path, projects }
for each project:
    files(action: "list", project: P)                 → pick kind "splat" inputs
    inspect(target: "stats", project: P, input: F)
    if count > 2M:  suggest_lod_settings → build_lod(mode: "decimate", ...)
    else:           convert(format: "sog")
    jobs(action: "wait", id: ...)                     → run jobs sequentially
```

Notes: jobs run concurrently as subprocesses, but GPU-heavy jobs contend — wait for
each before starting the next. `workspace(action: "set", path: ...)` re-points the
whole app live (create with `create: true`) — but **switching workspaces resets the
editor-control consent to OFF**, so a mixed headless+editor batch needs the user to
re-tick the toggle after each switch.

---

## Troubleshooting quick table

| Symptom | Meaning | Fix |
|---|---|---|
| `timeout` from headless tools | App not running / wrong port | Start Splat Studio; the server re-finds the port automatically on the next call |
| `no-editor` | App up, no GUI bridge | Open the app window; give it a second |
| `control-disabled` | Consent off | Settings → Agent control (MCP) — remember it resets on workspace switch |
| `gpu-required` | Collision / floater removal / `filterCluster` without GPU | Use a GPU machine, or the documented CPU fallbacks |
| `{ refused: true, preflight }` | Collision vertex-limit guard | Raise `voxelSize`, crop the region, or `overridePreflight: true` |
| `job-failed` | CLI run died | `jobs(action: "get")` — the tail of the log has the real error |

For the agent-facing playbook version of these recipes, see
`.claude/skills/splat-studio-workflows/`. Setup and troubleshooting:
[MCP_SETUP.md](MCP_SETUP.md).
