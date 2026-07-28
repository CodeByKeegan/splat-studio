---
name: dev-cycle
schedule: weekdays
skills: splat-studio-design-pass, splat-studio-add-feature, splat-studio-test, splat-studio-update-docs
opens: PR against dev
---

# Routine: development cycle

Move one thing forward. This is how feature work gets picked up between human sessions —
in public, off a public backlog, ending in a reviewable PR.
[Shared rules](README.md#rules-every-routine-inherits) apply.

**One item per run.** Finishing one increment well beats starting three.

## 1. Pick the item

In priority order, stop at the first hit:

1. an open issue labelled **`next`** (the human-curated queue — oldest first),
2. a flag listed as **unwired** in [`docs/CLI_COVERAGE.md`](../../docs/CLI_COVERAGE.md)
   that isn't excluded and has no open issue or PR already,
3. a **🔜 Near-term** entry in [`ROADMAP.md`](../../ROADMAP.md) small enough to land whole.

Skip anything that already has an open PR or a branch on `origin` — someone is on it.
Nothing eligible → stop and say so. Do not invent work, and do not pull from the
🧭 Exploring list: those are unresolved product bets, not tickets.

## 2. Design before building

Run the **`splat-studio-design-pass`** skill. Post its output — the problem, the options
considered, the chosen shape, and what it costs — as a comment on the issue (open one
first if the item came from coverage or the roadmap). The design is public before the
code exists, so it can be argued with.

**Stop and leave the design as a comment, without implementing**, if the item turns out to
need a product decision (what should this *do*?), changes an existing control's meaning,
or reaches past one panel. Those want a human's answer, and a clearly-argued proposal is a
good day's output. Say so in the report.

## 3. Build it

Branch `<type>/<kebab-summary>` off `dev` (types in [AGENTS.md](../../AGENTS.md)), then
implement per **`splat-studio-add-feature`**: server builder → client control with a
tooltip naming the CLI flag → a `check(...)` in `tests/e2e.mjs`. Match the surrounding
code; keep comments brief and what-not-why.

## 4. Verify

`npm run typecheck` and `npm test` must pass. Any new or changed control gets a visual
check via `npm run docs:capture` — open the regenerated screenshot and confirm it looks
native to the panel. Then run **`splat-studio-update-docs`** for the guide and screenshots,
and `npm run coverage` if a flag was wired.

## 5. Open the PR

Against `dev`, titled `<type>: <summary>`, linking the issue (`Closes #N`), with a
Verification section: what ran, what you observed, what the screenshot shows. End the body
with *"Authored autonomously by the scheduled development routine."*

Then report: what was picked and why, what landed, what was deferred and to which issue.
