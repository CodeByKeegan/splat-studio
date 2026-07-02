---
name: splat-studio-workflows
description: Agent playbook of end-to-end Splat Studio MCP recipes — web optimization, LOD, collision, renders (hero/360/motion-blur), scan cleanup, real-world scaling, origin recentering, generators, exports, visual QA, batch pipelines. Use when asked to accomplish a splat task (not just call one tool), or to pick the right workflow for a scene.
---

# Splat Studio workflow recipes

Operating contract (jobs, consent, error codes, coordinate frames): read
**splat-studio-mcp** first. Every recipe below assumes: app running, and for
*(editor)* recipes `inspect(target:"editor_status")` → `{connected:true, controlEnabled:true}`
(if control is off, ask the user to enable it — never work around consent).

After every job-starting call: `jobs(action:"wait", id, timeout_ms)` → on `done`,
`jobs(action:"get", id)` for outputs + log. Run GPU-heavy jobs sequentially.

## Decision guide

- **"Make it web-ready"** → stats first. `inspect(target:"stats")`: ≤~2M gaussians →
  `convert(format:"sog")`; bigger → `suggest_lod_settings` → `build_lod(mode:"decimate", ...suggestion)`.
- **"It looks noisy / has floaters"** → `convert(format:"ply", filterNaN:true, filterFloaters:{})`
  (GPU; CPU fallback: `filterValue:{column:"opacity",comparator:"gt",value:0.05}`), then compare
  before/after stats. Residual junk → `trim_region(mode:"keep", box:...)` around the subject.
- **"Walkable in an engine"** → `generate_collision(voxelSize:0.05, seedPos:[0,1,0], carve:{height:1.8,radius:0.4})`.
  On `{refused:true}`: raise voxelSize or crop via filterBox/filterSphere; `overridePreflight:true`
  only with user buy-in.
- **"A beauty shot"** → `render_image` with CLI-space `"x,y,z"` camera strings; DoF via
  `fStop`+`focusDistance`. Frame it first *(editor)*: `render_pose(action:"set")` +
  `viewport_screenshot(max_width:800)`.
- **"Wrong size / wrong origin"** *(editor)* → measure/origin recipes below.
- **"Share with a non-technical person"** → `convert(format:"html")` (single self-contained file).
- **Engine interchange** → `spz` (Niantic; `spzVersion:3` for old consumers), `glb`
  (KHR_gaussian_splatting), `csv` (data analysis).

## Recipes (exact call sequences)

**Import + inspect:** `projects(create)` → `import_file` (OVERWRITES same-name; name charset:
letters digits spaces `( ) . _ -`) → `inspect(stats)` → `get_summary` (per-column table is in
the job LOG, no file).

**Streamed LOD (decimate):** `suggest_lod_settings` → `build_lod(mode:"decimate",
...suggestion)`. Big scenes: `timeout_ms: 1800000`. Output = `lod-meta.json` bundle folder;
deleting that entry deletes the folder.

**Environment-shell LOD (combine):** lighter levels first (`convert(decimate:"50%")` per level),
then `build_lod(mode:"combine", lodFiles:[...], lodEnvFlags:[...])` — env flag = always-visible
backdrop (LOD −1); ≥1 non-env level required; `input` is LOD 0.

**360° pano:** `render_image(image:{projection:"equirect", camera:"0,1.6,0",
resolution:"4096x2048"})` — 2:1 aspect REQUIRED (else the CLI errors); OMIT fov/DoF
options (rejected, not ignored). Result can feed `set_view_option(option:"skybox", value:<file>)`.

**Motion blur:** add `cameraEnd`/`lookAtEnd` + `shutter:0.5, motionSamples:64` to a normal
render. Keep the move 10–20 cm.

**Scale to real (editor):** `load_into_viewport` → `panel(open, "panel-edit")` →
`measure(action:"measure", points:[[A],[B]])` on a known span (passing points turns measure
mode on; only after that do `viewport_click` taps place markers) →
`measure(action:"set_length", length:<m>)` → `measure(action:"measure")` → take `scale` →
`convert(format:"ply", scale)`. Verify: re-measure the new output ≈ real length.

**Recenter origin (editor):** `set_origin(point:[viewer-world])` → take returned `translate`
(already in the splat frame convert expects) → `convert(format:"ply", translate)`.

**Region carve/crop:** stage visually *(editor)* with `set_region(target:"crop_box", box)` +
screenshot, then apply headlessly: `trim_region(mode:"remove"|"keep", box|sphere)` (splat
frame — the same numbers as set_region; `""` = unbounded side; single-file splats only — not
meta.json/lod bundles; output always .ply).

**Frames cheat-sheet:** viewer `[x,y,z]` → splat frame `[x,-y,-z]` (convert/trim/regions/render
cameras); → voxel space `[-x,y,-z]` (collision seedPos only). Editor tools return CLI-ready
values — prefer them over hand conversion.

**Generators:** `inspect(target:"generator_params", input:"gen.mjs")` → `convert(input:"gen.mjs",
format:"ply", params:"k=v,k=v")`. Sample: `examples/gen-grid.mjs`.

**Visual QA (editor):** `load_into_viewport` (works for `.collision.glb` and `.voxel.json` too) →
`set_view_option(collision_style:"xray")` → `camera(action:"frame")` →
`viewport_screenshot(max_width:1024)` → judge the image; `history(undo|redo)` for form/view
missteps (never undoes job outputs or deletes).

**Batch sweep:** `workspace(get)` → per project `files(list)` → filter `kind:"splat"` →
stats-gated convert/LOD per the decision guide, waiting between jobs. `workspace(set)` re-points
the app live but **resets editor consent to OFF** — plan editor steps around switches.

## Reporting back

Report per job: output path(s) from `job.outputs`, before/after gaussian counts for destructive
filters, and the log tail on `job-failed`. If a recipe stops at a consent/GPU wall, say exactly
which call returned `control-disabled`/`gpu-required` and what the user can do.

User-facing versions of these recipes: `docs/MCP_WORKFLOWS.md`.
