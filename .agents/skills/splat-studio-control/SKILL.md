---
name: splat-studio-control
description: How to drive the Splat Studio app headlessly — start the server, the project/workspace model, and the HTTP API for every function (convert, collision, summary, generators). Use when operating, scripting, or testing the app, or before adding/changing a feature.
---

# Controlling Splat Studio

Splat Studio is a local GUI over `@playcanvas/splat-transform`. Two processes:
- **Server** — `server/index.mjs` (Express). Spawns the splat-transform CLI as
  job subprocesses and serves the built `dist/`. Binds `127.0.0.1` only.
- **Client** — Vite/TS/PlayCanvas in `client/`, talks to the server over relative
  `/api` + `/files` URLs.

## Starting the server

```
API_PORT=<port> SPLAT_WORKSPACE=<abs dir> node server/index.mjs
```
- `SPLAT_WORKSPACE` is a folder whose **each top-level subfolder is a project**.
  Drop/seed splats inside a project subfolder.
- The CLI must run under a **real Node** (the bundled `node.exe` when packaged) —
  its native WebGPU/Dawn device crashes inside Electron. `process.execPath` is a
  real Node in every mode, so `node server/index.mjs` is correct for scripting.
- GPU is required for voxelization/collision and `--filter-cluster`; SOG
  compression has a CPU fallback (`device: 'cpu'`).

## HTTP API (all JSON unless noted)

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | `{ ok, cli }` — `cli:true` means the CLI resolved |
| GET | `/api/versions` | `{ app, splatTransform }` versions |
| GET/POST | `/api/workspace` | get / switch (`{ path, create? }`) the workspace folder — live, no restart; switching resets editor consent |
| GET | `/api/projects` | `{ projects: string[] }` |
| POST | `/api/projects` | `{ name }` → create a project folder |
| GET | `/api/files?project=` | `{ files: [{ name, size, kind, viewable }] }` |
| POST | `/api/upload?project=&name=` | raw body stream → file (8 GB cap; overwrites) |
| DELETE | `/api/files/:rel?project=` | delete a file/folder |
| GET | `/api/stats?project=&input=` | gaussian count + extents (cached by path+mtime) |
| GET | `/api/gpus` | GPU adapters `[{ index, name }]` |
| POST | `/api/convert` | `{ project, input, format, options }` → `{ jobId }` (also `lod` + `webp` formats) |
| POST | `/api/collision` | `{ project, input, options }` → `{ jobId }` |
| POST | `/api/summary` | `{ project, input, options? }` → `{ jobId }` (analysis-only) |
| POST | `/api/trim` | `{ project, input, options: { mode, box?, sphere? } }` → `{ jobId }` (region carve/crop worker) |
| GET | `/api/generator-params?project=&input=` | `{ params }` — a .mjs generator's slider schema, or null |
| GET | `/api/jobs` | `{ jobs, concurrency }` — all jobs (no logs) + the concurrency cap |
| GET | `/api/jobs/:id` | `{ status: queued\|running\|done\|error, log, command, outputs, viewables }` |
| POST | `/api/jobs/:id/cancel` | kill a running job, or drop a queued one before it runs |
| POST | `/api/jobs/concurrency` | `{ max }` → how many jobs run at once (clamped 1–8; default 1, or `SPLAT_JOB_CONCURRENCY`) |
| GET/POST | `/api/layout` | persisted dock layout (per-workspace dotfile) |
| GET/POST | `/api/groups` | location-group members + proxy sidecar (viewer linked groups) |
| POST | `/api/editor/command` | forward `{ name, params }` to the GUI over the WS relay (consent-gated: 403 off, 409 no editor, 504 timeout) |
| GET | `/api/editor/status` | `{ connected, controlEnabled, editorProject, appVersion, ... }` |
| POST | `/api/editor/control` | `{ enabled }` — persist the consent toggle (the GUI's checkbox; agents must not flip it) |

### Running a job
POST to convert/collision/summary, then poll `/api/jobs/:id` until
`status` is `done` or `error`. Jobs queue FIFO and run up to the
concurrency cap at once (default 1), so a fresh job may sit `queued`
first. `job.outputs` lists the files that landed; `job.log` holds the
CLI stdout (the summary table for `-m`).

### `convert` formats
`ply`, `compressed-ply`, `sog`, `sog-unbundled`, `lod`, `spz`, `glb`, `csv`,
`html`. `options`: `iterations`, `spzVersion`, `decimate`, `filterNaN`,
`device` (`auto`|`cpu`), `lodLevels`/`lodKeepPercent`/`lodChunkCount`/
`lodChunkExtent`/`lodFiles`, and `params` (for `.mjs` generator inputs).

### `collision` options
`voxelSize`, `opacity`, `filterCluster`, `seedPos:[x,y,z]`,
`fillMode` (`none`|`external`|`floor`), `fillSize`, `carve`, `carveHeight`,
`carveRadius`, `meshShape` (`smooth`|`faces`). Seed is in CLI space (Y-up,
rotated 180° about Y from the viewer).

### `.mjs` generators
A generator module exports a `Generator` class with static `create(params)`
returning `{ count, columnNames, getRow(index, row) }`. Column values are raw
(log-space scale, logit opacity, SH-DC colour). It may also expose a static
`params` array (`[{name,label,min,max,step,default}]`) which the GUI turns into
live sliders. Sample: `examples/gen-grid.mjs`.

## Where the logic lives
- CLI command assembly: `server/commands.mjs` (`buildConvertCommand`,
  `buildCollisionCommand`, `buildSummaryCommand`).
- Routes / file-kind / upload / safety: `server/index.mjs`.
- Job subprocess + log capture: `server/jobs.mjs`.
- UI + viewer: `client/src/{main.ts,viewer.ts,api.ts}`, `client/index.html`.

Tooltips are native `title=` attributes naming the CLI flag in parens, e.g.
`(-m/--summary)`. Match that convention for any new control.
