# Splat Studio — project guide for Claude

Splat Studio is a desktop GUI over `@playcanvas/splat-transform` (SOG bundling, splat
format conversion, collision generation) with a PlayCanvas viewer. Express loopback backend
(`server/`) spawns the CLI as polled subprocess jobs; Vite/TS/PlayCanvas frontend (`client/`);
packaged as an Electron app. Repo: `github.com/CodeByKeegan/splat-studio`.

## Source of truth: task tracker — not markdown

**Project planning, design specs, scoping, and task tracking live on the internal coverage
board (one task per CLI flag) — not in markdown files.** When designing a feature, scoping
work, or recording a plan, write it there as tasks/subtasks, not into the repo.

User-facing product docs (`README.md`, `docs/USER_GUIDE.md`, `docs/AUTOMATION.md`) remain
markdown — the rule above is about internal planning/design/spec content. External
contributors: open a GitHub issue to propose or discuss changes.

## Git & commits

- Branch + PR per change; solo work may branch in place.

## Run, test, build

- Dev: `npm run dev`. Workspace root is set via the `SPLAT_WORKSPACE` env var 
  (each top-level subfolder is a project).
- Test: `npm test` (black-box e2e; set `SKIP_GPU=1` to skip GPU-only checks).
- Typecheck: `npm run typecheck`. Package: `npm run dist:win`.
- GPU is required for voxelization/collision and `--filter-cluster`; SOG has a CPU fallback.

## Operating & extending the app

See `.claude/skills/`: `splat-studio-control` (drive it headlessly via the HTTP API),
`splat-studio-mcp` (the MCP server contract), `splat-studio-workflows` (end-to-end MCP recipes),
`splat-studio-test`, `splat-studio-add-feature`, `splat-studio-update-deps`,
`splat-studio-update-docs`. The CLI command builders live in `server/commands.mjs`; routes,
file-kinds, and safety in `server/index.mjs`; the viewer in `client/src/viewer.ts`; the MCP
server in `mcp-server/`.

## Code style

Comments extremely brief — what, not why. No cross-task, date, or history references in code.
