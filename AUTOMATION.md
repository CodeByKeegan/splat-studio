# Splat Studio — autonomous maintenance

Splat Studio runs unattended agent sessions on a schedule: they track its two upstreams
(`@playcanvas/splat-transform`, `playcanvas`), test and merge open pull requests, and pick
up development work. Every one of those routines is a **prompt file in this repository**,
so what the agents do each day is public, versioned, and changeable by pull request.

## Routine bank — `.agents/workflows/`
| Routine | Schedule | Does |
| --- | --- | --- |
| [`dep-update`](.agents/workflows/dep-update.md) | weekdays | Bump an upstream when it ships, wire new CLI flags into the GUI, open a PR. |
| [`pr-merge`](.agents/workflows/pr-merge.md) | daily | Test every open PR against `dev` cumulatively; merge what's green and eligible. |
| [`dev-cycle`](.agents/workflows/dev-cycle.md) | weekdays | Take the top item off the public backlog, design it, build it, open a PR. |

The scheduler holds only a pointer — *"read `.agents/workflows/<name>.md` on `dev` and
follow it"* — so editing the file changes the routine. See
[the registry](.agents/workflows/README.md) for the rules every routine inherits and how
to propose a change. `npm run check-routines` validates the bank.

## Skill bank — `.claude/skills/`
The reusable "how" the routines call into (mirrored to `.agents/skills/` for Codex and
Antigravity by `npm run sync-skills`):

| Skill | Use |
| --- | --- |
| `splat-studio-control` | How to drive the app: server, project model, full HTTP API for every function. |
| `splat-studio-mcp` | The MCP server contract: tools, consent, jobs, coordinate frames, extending the surface. |
| `splat-studio-workflows` | End-to-end MCP recipes (web optimization, collision, renders, cleanup, scaling, batch). |
| `splat-studio-test` | Run/extend the regression suite. |
| `splat-studio-design-pass` | Design a control before building it: discover → design against the system → adversarially critique → record publicly. |
| `splat-studio-add-feature` | Wire a new CLI flag (or viewer feature) into the GUI end-to-end, with a test. |
| `splat-studio-update-deps` | Detect a dependency update, bump it, wire new flags, run tests, open a PR. |
| `splat-studio-update-docs` | Regenerate the user guide + screenshots so docs never drift from the UI. |

## Regression suite — `tests/e2e.mjs`
Black-box e2e: boots the server on a throwaway workspace seeded with a synthetic
splat + the sample generator, drives every server function over the HTTP API, and
asserts on outputs. `npm test` (add `SKIP_GPU=1` on machines without a GPU).
This is the safety net every change and dependency bump runs through — nothing merges red.

## Coverage that can't drift — `docs/CLI_COVERAGE.md`
`npm run coverage` runs the installed CLI's `--help`, diffs it against the flags the
server actually wires, and rewrites [the coverage table](docs/CLI_COVERAGE.md). Unwired
flags are the visible backlog: the dev routine pulls from them, and `--check` fails if the
table is stale.

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
diagrams (the app's process model, the routine loop, and the documentation-refresh loop),
and **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)** for the illustrated guide to every feature.

## Conventions
Branch + PR per change (worktrees preferred); commits authored **CodeByKeegan**
with Claude Code co-authorship (see the README's AI-assisted development section);
tooltips name the CLI flag in parens. Work is tracked in public — GitHub issues for the
backlog, `docs/CLI_COVERAGE.md` for flag coverage.
