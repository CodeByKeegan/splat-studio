# Scheduled workflow: dependency update

This is the prompt the maintainer's automation runs on a schedule to keep Splat Studio
current with upstream [`@playcanvas/splat-transform`](https://github.com/playcanvas/splat-transform)
and [`playcanvas`](https://github.com/playcanvas/engine) releases. It's committed here for
transparency and reproducibility. The heavy lifting lives in the `splat-studio-update-deps`
skill (`.claude/skills/` · `.agents/skills/`); this file is the trigger and its guardrails.

**Schedule:** weekdays, mid-morning local time.
**Mode:** maximum effort. For a non-trivial bump, fan the work across parallel sub-agents
(discover → design → adversarially critique → implement). Keep the cheap "is anything newer?"
check first and STOP immediately if nothing changed.

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
   recommendations in the same PR; open a GitHub issue for large ones. Then, for a
   `splat-transform` bump, diff the CLI `--help` against the flags already wired. For each
   new or changed user-facing flag, run a UX pass: discover its purpose, design it to mesh
   with the existing design system (never surface raw sentinel values; pair related
   numerics), and implement end-to-end per the `splat-studio-add-feature` skill with a
   `check(...)` in `tests/e2e.mjs`. Record it on the coverage board. For a `playcanvas`
   bump: re-run the suite and smoke-test the viewer.

4. **Verify** — `npm run typecheck` and `npm test` must pass (the e2e suite is the safety
   net). For any new or changed UI control, verify it visually via `npm run docs:capture`
   (renders the real packaged UI). Commit as `CodeByKeegan`; keep the standard
   `Co-Authored-By` attribution; never include session links.

5. **Refresh docs** — update the README "Built with" version line (numbers only), re-capture
   screenshots (`npm run docs:capture`), reconcile `docs/USER_GUIDE.md`, and run
   `npm run sync-skills` if any skill changed. Fold into the same PR.

6. **Open a PR against `dev`** titled `chore: bump <pkg> to <version> (+ N new flags wired)`
   with a Verification section, ending with
   *"Authored autonomously by the scheduled dependency-update routine."*
