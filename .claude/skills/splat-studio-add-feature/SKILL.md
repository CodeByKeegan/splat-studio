---
name: splat-studio-add-feature
description: Wire a new @playcanvas/splat-transform CLI flag (or playcanvas viewer capability) into the Splat Studio GUI end-to-end — server command builder, route if needed, client control with a tooltip, and an e2e test. Use when adding CLI coverage or a viewer feature, or when a dependency update introduces a new flag.
---

# Adding a feature to Splat Studio

Goal: surface a CLI flag in the GUI with a tooltip, then prove it with a test.
Read **splat-studio-control** first for the API/architecture. Work on a new
branch (worktree preferred); open a PR.

## 1. Pin the exact CLI semantics
Run the real CLI — never guess:
```
node node_modules/@playcanvas/splat-transform/bin/cli.mjs --help
```
Find the flag's grammar: is it a GLOBAL, a per-input ACTION (goes after the
input token), or an OUTPUT option? What are its args/defaults? Confirm by
running it against `workspace/demo-room.ply` (regenerate with `npm run demo`).

## 2. Server — `server/commands.mjs`
- Output-producing format → add to `OUTPUT_NAMES` and the relevant builder.
- Per-input action (e.g. a transform/filter) → push `args` right after
  `args.push(input)`, guarded on the relevant option. Validate inputs with the
  `num()` helper / a regex; the args array is shell-safe (spawned, not a shell).
- A genuinely new verb (no output file, like summary) → a new `buildXCommand`
  with `expectedOutputs`/`viewables`, plus a route in `server/index.mjs` wired
  through `startJob`. New file kinds go in `fileKind()`.

## 3. Client
- Types: extend `ConvertRequest.options` / add a request type in
  `client/src/api.ts`, and a helper that POSTs the route.
- UI: add a control in `client/index.html` in the right panel. Conditional rows
  toggle `.hidden` (format-driven in `updateConvertRows()`, input-driven for
  generator rows). Read its value in the panel's `onclick` and pass it through.
- **Tooltip**: native `title=` naming the flag in parens, e.g. `(-r/--rotate)`.
  Persisted form state is automatic (the delegated `#sidebar` change listener).
- Viewport features go in `client/src/viewer.ts` (immediate-layer draws; see the
  voxel/bounds/capsule code for the box/wireframe pattern).

## 4. Test + verify
- Add an e2e `check(...)` in `tests/e2e.mjs` (see **splat-studio-test**).
- `npm run typecheck && npm test` until green.
- For UI/viewport, build `dist/` and drive it in a browser preview against an
  isolated server (own port + temp workspace) — assert via DOM/`window.__viewer`.

## 5. Ship
Commit (no AI attribution; author CodeByKeegan), push the branch, open a PR with
a "Verification" section. Check off the matching Asana task.

## Exclusions (not applicable to a GUI)
`--help/-h`, `--version/-v`, `--quiet/-q` (the summary feature uses `-q`
internally), `--tty/--no-tty` (always `--no-tty`).
