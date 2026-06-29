---
name: splat-studio-update-deps
description: Autonomous maintenance — check whether @playcanvas/splat-transform or playcanvas published a new version, bump it, wire any new CLI flags into the GUI, run the regression suite (adding tests for new functionality), and open a PR. Use on a schedule or when told a dependency updated.
---

# Keeping Splat Studio current

This is the routine the scheduled agent runs. It is idempotent: if nothing
changed, it makes no changes. Always work on a fresh branch + worktree and open
a PR — never commit dependency bumps straight to `main`.

## 1. Detect updates
```
npm view @playcanvas/splat-transform version
npm view playcanvas version
```
Compare to the installed versions (`node -p "require('<pkg>/package.json').version"`
or `package.json`). If neither is newer, **stop — report "up to date" and exit.**

## 2. Branch + bump
```
git worktree add -b chore/bump-<pkg>-<version> ../splat-studio-bump origin/main
# junction node_modules from a sibling checkout, or npm install
npm install @playcanvas/splat-transform@latest   # and/or playcanvas@latest
```

## 3. Diff the CLI surface (splat-transform bumps)
```
node node_modules/@playcanvas/splat-transform/bin/cli.mjs --help
```
Compare the ACTIONS / OUTPUTS / option groups against what's wired in
`server/commands.mjs` + the client. For **each new or changed user-facing flag,
do NOT mechanically bolt a field onto the panel** — production-grade UI/UX is the
bar. Run a UX pass first:

1. **Discover purpose.** What is the flag *for* (use cases, who reaches for it),
   and how should a polished tool surface it? Read the upstream release notes/docs
   (and the PlayCanvas docs for viewer/LOD features). Treat the raw flag value as
   an implementation detail to hide — e.g. expose `--lod -1` as a plain-language
   "environment / always-visible backdrop" affordance, never a literal `-1`; treat
   pure perf knobs (`--max-workers`) as advanced/secondary, not peers of quality
   settings.
2. **Design to mesh.** Read the design system (`client/src/style.css` +
   `client/index.html`) and pick the control that matches the existing vocabulary:
   pair related numerics in a `.field-row` of two `.field.half` (like the Chunk and
   Voxel rows) instead of stacking full-width fields; segment with `.group`; gate
   visibility like the neighbouring rows; put the flag name + caveat in `title=`.
3. **Implement** end-to-end per **splat-studio-add-feature** (server builder +
   client control + tooltip), add a `check(...)` to `tests/e2e.mjs`, and
   create/check-off the matching Asana task (project gid [redacted-id]).

For a **non-trivial bump** (a new feature like environment-LOD, or several flags),
run a **Workflow** to fan this out: discover (purpose · design-system fit ·
integration) → synthesize an implementable blueprint → **adversarially critique it**
(does it look native? do the diffs apply to **the worktree you are editing**, not a
stale sibling checkout?), then implement. Read the critique before trusting it —
verify any "this doesn't exist" claim against the actual branch first.

For a **playcanvas** bump, re-run the suite + a browser smoke test of the viewer
(gsplat load, collision wireframe, voxels) and fix any breakage.

## 4. Verify
```
npm run typecheck
npm test
```
Both must pass. For UI/viewer changes, **verify the control visually, not just via
tests.** The most reliable way in this app is the Electron capture harness (step 5's
`npm run docs:capture` renders the real packaged UI): drive it to the relevant panel
state and confirm the control both works and **looks native** to the panel. (A
browser preview also works, but the Vite proxy pins the API port, so it conflicts
when another checkout's dev server is already running.)

## 5. Refresh docs + version line
Update the README "Built with [PlayCanvas](…) `X` · [@playcanvas/splat-transform](…) `Y`"
line (just below the title, marked with a `<!-- versions: … -->` comment) to the new
versions — change only the backticked version numbers, keep the hyperlinks. The CI
release notes pick the versions up automatically from node_modules. Then run **splat-studio-update-docs** so the user guide and screenshots
reflect any new flag or panel: `npm run docs:capture`, reconcile `docs/USER_GUIDE.md`
(and `docs/AUTOMATION.md` if a loop changed), and **open the regenerated screenshot
for any changed panel to confirm the new control renders natively** (capture the
specific state if the canonical shots don't cover it). If a fresh worktree's Electron
binary failed to install, set `ELECTRON_OVERRIDE_DIST_PATH` to the main checkout's
`node_modules/electron/dist`. Fold the doc diff into this same PR.

## 6. Ship
Commit (author CodeByKeegan, no AI attribution), push, open a PR titled
`chore: bump <pkg> to <version> (+ N new flags wired)`, with a Verification
section listing the `npm test` result and any new flags surfaced.

## Notes
- The regression suite (`tests/e2e.mjs`) is the safety net — if a bump breaks an
  existing function, it fails there first.
- Keep the suite green: features the build lacks must skip, not fail.
- If a bump only changes internals (no new user-facing flag), still bump + test +
  PR so the app tracks upstream.
