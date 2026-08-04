# Contributing to Splat Studio

Thanks for your interest — issues and pull requests are both welcome.

## Branching model

This project uses a two-branch flow:

- **`main`** — stable. Ships the **stable** release channel. Never commit or PR directly here.
- **`dev`** — integration. Ships the **beta** release channel. **All pull requests target `dev`.**

`main` only ever moves by promoting `dev`. So: branch off `dev`, and open your PR against
`dev`. PRs opened against `main` will be asked to re-target.

## Review policy

The maintainer (@CodeByKeegan) reviews and merges all PRs. Only maintainers have write
access, so that — not the review settings — is what gates merging; contributors work from
a fork and open a PR, as usual.

Because there is currently a single maintainer, the branch rulesets **do not require an
approving review**: GitHub forbids approving your own PR, so a required approval would be
unsatisfiable and every merge would need a rule bypass. The rulesets gate on CI instead —
`dev` requires the `test` job (build + typecheck + regression + MCP e2e), and `main`
requires `guard` (only `dev` may merge into `main`). Both branches still require a PR,
forbid force-pushes and deletion, and require review threads to be resolved.

**When a second maintainer joins**, set `required_approving_review_count` back to `1` and
re-enable `require_code_owner_review` on both rulesets — at that point the requirement is
satisfiable and worth having.

## Before you start

For anything larger than a small fix, **[open an issue](https://github.com/CodeByKeegan/splat-studio/issues)
first** so we can agree on the approach — it saves everyone rework.

## Development setup

See **[Getting started](README.md#getting-started)** for prerequisites (Node 22+) and the
clone → install → `npm run dev` quickstart.

## Making a change

1. Fork, then branch off `dev`, named `<type>/<kebab-summary>` — types: `feat`, `fix`,
   `chore`, `docs`, `ci`, `refactor` (e.g. `feat/lod-auto-tune`, `fix/region-gizmo-detach`).
2. Keep it focused — one feature or fix per PR.
3. Match the existing style: **brief, what-not-why code comments**; new `splat-transform`
   CLI flags get a GUI control **with a tooltip that names the flag** and a `check(...)`
   in the e2e suite. (The `.claude/skills/` playbooks show exactly how features and
   dependency bumps are wired.)
4. Run the checks locally — they must pass:
   ```bash
   npm run typecheck
   npm test            # tests/e2e.mjs; use SKIP_GPU=1 to skip GPU-only checks
   ```
   UI/viewer changes should also be verified against a running `npm run dev`.

## Opening the PR

- Target **`dev`**.
- Include a short **Verification** section: what you ran and what you observed.
- CI builds a **beta** release from `dev` on merge, so your change is testable quickly.

Contributions are accepted under the project's [Apache-2.0 license](LICENSE). AI-assisted
contributions are welcome and normal here — see the
[AI-assisted development](README.md#ai-assisted-development) note; keep `Co-Authored-By`
attribution on AI-authored commits.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).
