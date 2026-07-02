# Splat Studio — autonomous maintenance

Splat Studio keeps itself current with its two upstreams
(`@playcanvas/splat-transform`, `playcanvas`) and verifies every function on a
test splat. The pieces:

## Regression suite — `tests/e2e.mjs`
Black-box e2e: boots the server on a throwaway workspace seeded with a synthetic
splat + the sample generator, drives every server function over the HTTP API, and
asserts on outputs. `npm test` (add `SKIP_GPU=1` on machines without a GPU).
This is the safety net every change and dependency bump runs through.

## Skill bank — `.claude/skills/`
| Skill | Use |
| --- | --- |
| `splat-studio-control` | How to drive the app: server, project model, full HTTP API for every function. |
| `splat-studio-mcp` | The MCP server contract: tools, consent, jobs, coordinate frames, extending the surface. |
| `splat-studio-workflows` | End-to-end MCP recipes (web optimization, collision, renders, cleanup, scaling, batch). |
| `splat-studio-test` | Run/extend the regression suite. |
| `splat-studio-add-feature` | Wire a new CLI flag (or viewer feature) into the GUI end-to-end, with a test. |
| `splat-studio-update-deps` | The autonomous routine: detect a dependency update, bump it, wire new flags, run tests, open a PR. |
| `splat-studio-update-docs` | Regenerate the user guide + screenshots so docs never drift from the UI. |

## The scheduled routine
A cron agent runs `splat-studio-update-deps` on a schedule. Each run:
1. checks `npm view <pkg> version` against what's installed — if nothing is newer, it exits;
2. otherwise branches, bumps, diffs `splat-transform --help` against the wired
   surface, wires each new flag (`splat-studio-add-feature`) + adds a test;
3. runs `npm run typecheck && npm test`, then opens a PR.

So new upstream features flow into the GUI automatically, gated by review (a PR)
and the regression suite.

## Documentation that maintains itself
The user guide is a build artifact, not hand-kept prose. `npm run docs:capture`
runs the real app in an Electron window (`scripts/capture-docs.mjs`) against the
synthetic demo splat and re-captures every annotated panel screenshot into
`docs/screenshots/`. The dependency-update run ends by invoking
`splat-studio-update-docs`, which re-captures and reconciles `docs/USER_GUIDE.md`
with the current panels/flags — so docs are refreshed in the same PR that adds a
feature, and never drift from the shipping UI.

## Architecture & diagrams
See **[docs/AUTOMATION.md](docs/AUTOMATION.md)** for the full architecture with
diagrams (the app's process model, the dependency-update loop, and the
documentation-refresh loop), and **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)** for the
illustrated guide to every feature.

## Conventions
Branch + PR per change (worktrees preferred); commits authored **CodeByKeegan**
with no AI attribution; tooltips name the CLI flag in parens. New feature work
is tracked on the Asana coverage board (one task per CLI flag).
