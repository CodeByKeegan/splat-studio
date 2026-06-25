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
`server/commands.mjs` + the client. For **each new or changed flag**, wire it in
per **splat-studio-add-feature** (server builder + client control + tooltip) and
add a `check(...)` to `tests/e2e.mjs`. Also create an Asana task per new flag (or
check off ones now covered) on the coverage board if one is configured. For a
**playcanvas** bump, re-run the suite + a browser smoke test of the viewer
(gsplat load, collision wireframe, voxels) and fix any breakage.

## 4. Verify
```
npm run typecheck
npm test
```
Both must pass. For UI/viewer changes, drive a browser preview against an
isolated server (own port, temp workspace) and confirm the new control works.

## 5. Ship
Commit (author CodeByKeegan, no AI attribution), push, open a PR titled
`chore: bump <pkg> to <version> (+ N new flags wired)`, with a Verification
section listing the `npm test` result and any new flags surfaced.

## Notes
- The regression suite (`tests/e2e.mjs`) is the safety net — if a bump breaks an
  existing function, it fails there first.
- Keep the suite green: features the build lacks must skip, not fail.
- If a bump only changes internals (no new user-facing flag), still bump + test +
  PR so the app tracks upstream.
