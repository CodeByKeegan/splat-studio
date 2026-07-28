---
name: pr-merge
schedule: daily
skills: splat-studio-test
opens: merges into dev (eligible PRs only)
---

# Routine: test & merge open PRs

Keep `dev` moving without letting anything red into it. Every open PR gets tested
cumulatively against the real `dev`; what's green **and eligible** merges, everything
else is reported. [Shared rules](README.md#rules-every-routine-inherits) apply — this is
the one routine that merges, and it merges only through the GitHub API, never by pushing.

## 1. Collect the actionable PRs

List open PRs. **Actionable** = base `dev`, not a draft, not conflicted. Never touch a PR
targeting `main` — promoting `dev` to `main` cuts a stable release and is always a
deliberate human act. Zero actionable PRs → one-line report, done.

Fetch each head (`refs/pull/N/head`) and trial-merge against `origin/dev` with
`git merge-tree`. Conflicted ones are skipped and reported, not fixed — the author owns
their branch.

## 2. Decide what may merge unattended

| PR | This routine |
| --- | --- |
| From a branch in this repo, authored by the maintainer or a routine | tests, then merges if green |
| From a fork or an outside contributor | tests, comments the result, **leaves it for review** |

Outside contributions are welcome and get a fast, useful test report — they just don't
merge themselves. Before running the suite on a fork PR, look at the diff: if it touches
`package.json` scripts, the lockfile's registry entries, `.github/workflows/`, or
`.agents/workflows/`, **do not execute it** — report that it needs the maintainer's eyes
first. Running a stranger's branch is running their code.

## 3. Test cumulatively, oldest first

On a local branch off `origin/dev`, one PR at a time:

1. merge the PR head locally,
2. `npm install` if the lockfile changed,
3. `npm test` and `npm run typecheck` (`SKIP_GPU=1` where there's no GPU — note it in the report).

Only if green **and** eligible: merge that PR via the GitHub API (merge commit), fetch
`origin/dev`, and confirm `git diff --quiet origin/dev HEAD` — the tree you tested must be
the tree that landed — before moving to the next PR.

Stop conditions: a branch fails → skip it, report why, continue with the next. `dev`
diverges unexpectedly or a post-merge check fails → **stop merging entirely** and report.
Never revert, never push to `dev`/`main`, never push to a PR branch, never merge a draft
or a conflicted PR.

## 4. Then check upstream

Compare `npm view @playcanvas/splat-transform version` and `npm view playcanvas version`
against `dev`'s `package.json`. If either is newer, run [`dep-update.md`](dep-update.md)
from step 2, and merge the resulting bump PR once its suite is green.

## 5. Report

A short summary: merged (in order), skipped (with reasons), `dev`'s final test status, any
dependency bump. Then notify the maintainer in one line — e.g. *"splat-studio daily: merged
3 PRs, bumped splat-transform, dev green (36/36)"* — leading with anything that needs
attention. On a quiet day (nothing open, nothing to bump, nothing wrong), skip the
notification.
