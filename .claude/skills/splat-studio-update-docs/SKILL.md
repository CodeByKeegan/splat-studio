---
name: splat-studio-update-docs
description: Regenerate Splat Studio's documentation — re-capture the annotated UI screenshots and reconcile docs/USER_GUIDE.md and docs/AUTOMATION.md with the current panels, flags, and automation pipeline. Run after any app/dependency change (it's the final step of splat-studio-update-deps) or on its own.
---

# Refreshing Splat Studio's docs

Documentation is a build artifact here, not hand-maintained prose. After any change
to the UI, the CLI surface, or the automation, regenerate the docs so they never
drift. Work on a branch + PR like any other change.

## 1. Recapture the screenshots
```
npm run docs:capture
```
This generates the demo splat, builds the client, then runs
`scripts/capture-docs.mjs` — a real Electron window driven over the embedded server
against the synthetic `demo-room` splat. It overwrites `docs/screenshots/*.png` in
place, so the git diff shows exactly which panels changed visually.

- If you **added a panel or a documented control**, add a scene to the `scenes`
  array in `scripts/capture-docs.mjs` (open the panel via `window.__doc.rail(...)`,
  set any state, then `window.__doc.hl([selectors], {numbered:true})`), and reference
  the new `screenshots/<name>.png` from the guide.
- Captures must be non-empty (the script prints KB + dimensions per shot and retries
  empty frames). If a shot is 0 KB, the window wasn't foreground/painting — the
  script already forces `alwaysOnTop` + a paint tick; re-run.

## 2. Reconcile the prose
- **docs/USER_GUIDE.md** — one section per panel, each step naming the control and
  (in passing) the CLI flag. If a flag/control was added, removed, or renamed, update
  the matching step and table row. Keep the screenshot references valid.
- **docs/AUTOMATION.md** — update only if the architecture or a loop changed. The
  Mermaid diagrams render on GitHub; validate any edit before committing.

## 3. Verify
```
npm run typecheck
```
Open `docs/USER_GUIDE.md` and confirm every `screenshots/*.png` link resolves and
each panel is covered. Spot-check one or two regenerated PNGs actually show the app
(not a blank frame).

## 4. Ship
Commit (author CodeByKeegan, no AI attribution), push, open a PR titled
`docs: refresh user guide + screenshots`. When run as the tail of a dependency bump,
fold the doc changes into that same PR instead.

## Notes
- `docs/.capture-workspace/` is a throwaway seeded workspace — it's gitignored; never
  commit it.
- The capture is reproducible on any machine (uses the bundled demo splat), so the
  doc loop can run unattended in the weekly cron.
