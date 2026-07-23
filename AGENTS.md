# Splat Studio — agent guide

Splat Studio is a desktop GUI over `@playcanvas/splat-transform` (SOG bundling, splat
format conversion, collision generation) with a PlayCanvas viewer. Express loopback backend
(`server/`) spawns the CLI as polled subprocess jobs; Vite/TS/PlayCanvas frontend (`client/`);
packaged as an Electron app. Repo: `github.com/CodeByKeegan/splat-studio`.

## Source of truth: task tracker — not markdown

**Project planning, design specs, scoping, and task tracking live on the maintainer's
task board (one task per CLI flag) — not in markdown files.** When designing a feature,
scoping work, or recording a plan, write it there as tasks/subtasks, not into the repo.

User-facing product docs (`README.md`, `docs/USER_GUIDE.md`, `docs/AUTOMATION.md`) remain
markdown — the rule above is about internal planning/design/spec content. External
contributors: open a GitHub issue to propose or discuss changes.

## Git & commits

- Two-branch flow: PRs target `dev` (beta channel); `main` (stable channel) only moves by
  promoting `dev`. Never commit directly to `dev` or `main` — both are ruleset-protected.
  See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Branch naming**: `<type>/<kebab-summary>` off `dev`, where type is one of
  `feat` (new capability), `fix` (bug fix), `chore` (deps, config, maintenance),
  `docs` (documentation only), `ci` (workflows/pipeline), `refactor` (no behavior change).
  Examples: `feat/lod-auto-tune`, `fix/region-gizmo-detach`, `chore/bump-splat-transform-2.8.0`.
- Merging `dev` → `main` cuts a **stable release**; every push to `dev` cuts a **beta**.
  Promote deliberately, not per-PR.

## Dependency updates (PlayCanvas / splat-transform)

Don't just wire new CLI flags — **read what each release actually does** (release notes /
CHANGELOG for every version crossed). Look for: behavior/API changes to the calls in
`server/commands.mjs` and `client/src/viewer.ts`; deprecations and newly recommended
usage; optimizations worth adopting (better defaults, faster paths); and upstream fixes
that let a local workaround be removed. Apply small recommendations in the bump PR; open
an issue for large ones. Full procedure: the `splat-studio-update-deps` skill.

## Run, test, build

- Dev: `npm run dev`. Workspace root is set via the `SPLAT_WORKSPACE` env var
  (each top-level subfolder is a project).
- Test: `npm test` (black-box e2e; set `SKIP_GPU=1` to skip GPU-only checks).
- Typecheck: `npm run typecheck`. Package: `npm run dist:win`.
- GPU is required for voxelization/collision and `--filter-cluster`; SOG has a CPU fallback.

## Operating & extending the app

Reusable capabilities are packaged as skills (Agent Skills format: a directory with a
`SKILL.md`). Claude Code loads them from `.claude/skills/`; Codex and Antigravity load the
same skills from `.agents/skills/` (generated from `.claude/skills/` by `npm run sync-skills`).
Available skills:

- `splat-studio-control` — drive the app headlessly via the HTTP API
- `splat-studio-mcp` — the MCP server contract
- `splat-studio-workflows` — end-to-end MCP recipes
- `splat-studio-test` — run the e2e regression suite
- `splat-studio-add-feature` — wire a new CLI flag / viewer capability end-to-end
- `splat-studio-update-deps` — autonomous dependency-bump maintenance
- `splat-studio-update-docs` — regenerate screenshots and user docs

Code map: CLI command builders in `server/commands.mjs`; routes, file-kinds, and safety in
`server/index.mjs`; the viewer in `client/src/viewer.ts`; the MCP server in `mcp-server/`.

## Code style

- Comments extremely brief — what, not why. No cross-task, date, or history references in code.
- Match the surrounding idiom: TypeScript in `client/`, plain ESM `.mjs` in `server/`,
  `electron/`, `scripts/`, `mcp-server/`.
- New user-facing controls follow the design system (`client/src/style.css`): pair related
  numerics in a `.field-row` of two `.field.half`; the tooltip (`title=`) names the CLI flag.
- Every new CLI flag or route gets a `check(...)` in `tests/e2e.mjs`; UI changes get a
  visual check via the Electron capture harness (`npm run docs:capture`), not just green tests.
