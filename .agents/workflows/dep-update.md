---
name: dep-update
schedule: weekdays, mid-morning
skills: splat-studio-update-deps, splat-studio-design-pass, splat-studio-add-feature, splat-studio-test, splat-studio-update-docs
opens: PR against dev
---

# Routine: dependency update

Keep Splat Studio current with its two upstreams —
[`@playcanvas/splat-transform`](https://github.com/playcanvas/splat-transform) and
[`playcanvas`](https://github.com/playcanvas/engine) — and surface what they add.

The heavy lifting lives in the **`splat-studio-update-deps`** skill; this file is the
trigger, its guardrails, and the stop conditions. [Shared rules](README.md#rules-every-routine-inherits)
apply. **Maximum effort**: for a non-trivial bump, fan the work across parallel sub-agents
(discover → design → adversarially critique → implement). Keep step 1's cheap check first
and stop immediately if nothing changed — that's most days.

1. **Check for upstream updates** — compare installed vs latest:
   - `npm view @playcanvas/splat-transform version` vs `node -p "require('@playcanvas/splat-transform/package.json').version"`
   - `npm view playcanvas version` vs `node -p "require('playcanvas/package.json').version"`

   If NEITHER is newer, STOP — do nothing, open no PR. (This is the common case.)

2. **If one is newer** — branch `chore/bump-<pkg>-<version>` off `dev`, then
   `npm install <pkg>@latest` for the updated package(s).

3. **Read the release, then wire it** — for every bump, read the upstream release notes /
   CHANGELOG for each version crossed (both packages). Beyond new CLI flags, look for:
   behavior/API changes affecting `server/commands.mjs` invocations or the engine usage in
   `client/src/viewer.ts`; deprecations and newly recommended usage; optimizations worth
   adopting; and fixed upstream bugs that let a local workaround be removed. Apply small
   recommendations in the same PR; open a GitHub issue for large ones.

   Then, for a `splat-transform` bump, run `npm run coverage` — it diffs the CLI's `--help`
   against the flags the GUI wires and rewrites [`docs/CLI_COVERAGE.md`](../../docs/CLI_COVERAGE.md).
   Every flag it reports as unwired is either work for this PR or a tracked issue. For each
   new or changed user-facing flag, run the **`splat-studio-design-pass`** skill (discover →
   design → critique) before writing any UI, then implement end-to-end per
   **`splat-studio-add-feature`** with a `check(...)` in `tests/e2e.mjs`. Commit the
   regenerated coverage table alongside the wiring. For a `playcanvas` bump: re-run the
   suite and smoke-test the viewer.

4. **Verify** — `npm run typecheck` and `npm test` must pass (the e2e suite is the safety
   net). For any new or changed UI control, verify it visually via `npm run docs:capture`
   (renders the real packaged UI) — green tests are not evidence that a control looks native.

5. **Refresh docs** — update the README "Built with" version line (numbers only), re-capture
   screenshots (`npm run docs:capture`), reconcile `docs/USER_GUIDE.md`, and run
   `npm run sync-skills` if any skill changed. Fold into the same PR.

6. **Open a PR against `dev`** titled `chore: bump <pkg> to <version> (+ N new flags wired)`,
   with a Verification section (test result, flags wired, coverage delta) and a
   **Release-notes review** line summarizing what upstream changed and what was adopted or
   deferred (with issue links). End the body with
   *"Authored autonomously by the scheduled dependency-update routine."*
