---
name: splat-studio-update-deps
description: Autonomous maintenance — check whether @playcanvas/splat-transform or playcanvas published a new version, bump it, wire any new CLI flags into the GUI, run the regression suite (adding tests for new functionality), and open a PR. Use on a schedule or when told a dependency updated.
---

# Keeping Splat Studio current

This is the "how" behind the **[dep-update routine](../../../.agents/workflows/dep-update.md)**
— that file is the schedule and its guardrails; this one is the procedure, and it
works the same run by hand. It is idempotent: if nothing changed, it makes no changes. Always work on a fresh branch + worktree off `dev`
and open a PR **against `dev`** (the beta channel) — never commit straight to
`dev` or `main`; `main` only moves by promoting `dev`.

## 1. Detect updates
```
npm view @playcanvas/splat-transform version
npm view playcanvas version
```
Compare to the installed versions (`node -p "require('<pkg>/package.json').version"`
or `package.json`). If neither is newer, **stop — report "up to date" and exit.**

## 2. Branch + bump
```
git worktree add -b chore/bump-<pkg>-<version> ../splat-studio-bump origin/dev
# junction node_modules from a sibling checkout, or npm install
npm install @playcanvas/splat-transform@latest   # and/or playcanvas@latest
```

## 3. Read the release — not just the flag list
**For every bump (both packages), actually read what the release does**: the GitHub
release notes / CHANGELOG for each version between installed and latest. You are
looking for more than new CLI flags:

- **Behavior/API changes** to things we call: the CLI invocations built in
  `server/commands.mjs` (flag semantics, defaults, output naming), and the engine
  APIs used in `client/src/viewer.ts` / `client/src/main.ts` (gsplat loading,
  cameras, gizmos, render targets).
- **Recommended usage changes & optimizations**: deprecations we should migrate off,
  new preferred APIs or flags that would improve quality/perf (e.g. a better
  compression default, a faster loader path, a new LOD strategy), and perf notes
  that suggest re-tuning our defaults.
- **Fixes that let us remove workarounds**: check whether anything in our code
  exists to paper over an upstream bug the release fixed (search comments near the
  relevant call sites).

Apply small recommended changes in this same PR (with a test or visual check);
for anything large, open a GitHub issue describing the recommendation and its
expected benefit so it's tracked instead of lost.

## 3b. Diff the CLI surface (splat-transform bumps)
```
npm run coverage    # runs the CLI's --help, diffs it against the wired flags
```
This rewrites `docs/CLI_COVERAGE.md` — the public coverage table. Every flag it
reports as **unwired** is either work for this PR or an issue to open; commit the
regenerated table with the wiring.

For **each new or changed user-facing flag, do NOT mechanically bolt a field onto
the panel** — production-grade UI/UX is the bar. Run the **splat-studio-design-pass**
skill first (discover what the flag is for → design it against the existing design
system → adversarially critique the result → record it publicly), then **implement**
end-to-end per **splat-studio-add-feature** (server builder + client control +
tooltip) and add a `check(...)` to `tests/e2e.mjs`.

For a **non-trivial bump** (a new feature like environment-LOD, or several flags),
run a **Workflow** to fan the design pass out across parallel sub-agents: discover
(purpose · design-system fit · integration) → synthesize an implementable blueprint →
**adversarially critique it** (does it look native? do the diffs apply to **the
worktree you are editing**, not a stale sibling checkout?), then implement. Read the
critique before trusting it — verify any "this doesn't exist" claim against the actual
branch first.

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
Commit (author CodeByKeegan; no AI/Claude attribution trailers in the commit message —
this is a maintenance branch, not a Claude Code session artifact), push, open a PR
**against `dev`** titled `chore: bump <pkg> to <version> (+ N new flags wired)`, with a
Verification section listing the `npm test` result, any new flags surfaced, and a
**Release-notes review** line summarizing what the upstream release changed and any
usage/optimization recommendations adopted (or issue links for deferred ones).
End the PR body with: *Authored autonomously by the scheduled dependency-update routine.*
Never include claude.ai session links or a "Generated by Claude Code" footer.

**The PR-creation tool may auto-append a "Generated by Claude Code" footer with a
claude.ai session link to the body, regardless of what you passed in — it is not
optional and not under your control at call time.** Treat this as expected: immediately
after creating (or updating) the PR, re-fetch it and check the body for that footer or
any `claude.ai` link. If present, call the update-PR tool again with the body trimmed
back to exactly what you authored. Do this before considering step 6 done — an
unstripped footer is a shipped defect, not a cosmetic one.

## Notes
- The regression suite (`tests/e2e.mjs`) is the safety net — if a bump breaks an
  existing function, it fails there first.
- Keep the suite green: features the build lacks must skip, not fail.
- If a bump only changes internals (no new user-facing flag), still bump + test +
  PR so the app tracks upstream.
