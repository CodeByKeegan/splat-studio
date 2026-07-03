---
name: splat-studio-test
description: Run Splat Studio's end-to-end regression suite — boots the server on a throwaway workspace seeded with a test splat and drives every function (convert formats, SOG/LOD, summary, generators+params, collision presets) asserting on outputs. Use to verify the app works, before/after a change, or after a dependency bump.
---

# Testing Splat Studio

The suite is `tests/e2e.mjs`. It is black-box: it boots `server/index.mjs` on a
temp `SPLAT_WORKSPACE`, seeds a project with a synthetic splat
(`scripts/make-test-splat.mjs`) + the sample generator (`examples/gen-grid.mjs`),
then exercises every server function over the HTTP API and asserts. Exit 0 = all
passed; exit 1 = a failure (names listed).

## Run it
```
npm test                  # everything (needs the GPU for collision/voxels)
SKIP_GPU=1 npm test       # skip GPU-only checks (collision, voxel output)
```
Requires `node_modules` present (`npm install`, or junction it from a sibling
checkout) and a real Node (the CLI's WebGPU device won't run inside Electron).

## What it covers
health · projects · file-kind classification · convert → every format
(ply / compressed-ply / spz / glb / csv / html / sog / sog-unbundled / streamed
LOD) · `-m/--summary` (asserts the stats table, no file written) · `.mjs`
generator + `-p/--params` (asserts the synthesized gaussian count) ·
`/api/generator-params` slider schema · path-traversal rejection · collision
presets (object, indoor).

## Extending it
When a new CLI flag is wired into the GUI (see **splat-studio-add-feature**), add
a `check(...)` for it: drive the relevant `/api/*` route through `runJob(...)`
and assert on `job.status`, `job.outputs`, or `job.log`. Keep each check
independent and fast (the synthetic splat is ~28K gaussians). Mark GPU-only
checks behind `if (!SKIP_GPU)`. Re-run `npm test` until green.

A feature that the build doesn't yet have should **skip gracefully** (e.g. treat
a 404 route as "not present") rather than fail — the suite must stay green on any
branch and only assert features that exist.
