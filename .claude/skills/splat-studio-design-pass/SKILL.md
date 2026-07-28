---
name: splat-studio-design-pass
description: The design pass Splat Studio runs before any new user-facing control is built — discover what the capability is for, design it against the existing design system, adversarially critique the design, then record it publicly. Use before wiring a new CLI flag or viewer feature, during a dependency bump that adds flags, or whenever a control's shape is not obvious.
---

# The design pass

A CLI flag is not a feature. `--filter-cluster 0.02 8` is a flag; "remove floating
scan noise" is a feature. This pass is what turns one into the other, and it runs
**before** any HTML is written — **splat-studio-add-feature** builds what this pass
decided.

Its output is a short written design, posted publicly (issue comment or PR body). The
point is that the reasoning is arguable by someone who wasn't there.

Run it for: a new user-facing flag, a flag whose meaning changed upstream, a viewer
capability, or any control whose shape isn't obvious. Skip it for a pure rename or a
mechanical value change.

## 1. Discover — what is this *for*?

Don't design from the `--help` line. Find out:

- **The job it does.** What is a user trying to accomplish when they reach for this?
  Read the upstream release notes, the `splat-transform` docs, and the PlayCanvas docs
  for viewer/LOD features. Run the flag against `workspace/demo-room.ply`
  (`npm run demo`) and look at the result — the real output settles arguments the docs
  don't.
- **Who reaches for it.** Someone converting a phone scan for the web, or someone
  tuning an encoder? That decides whether it's a primary control or an advanced one.
- **What we already have.** Search `client/index.html` and `server/commands.mjs` — the
  app may already express this idea under a different name. Extending an existing
  control beats adding a peer next to it.
- **What it costs.** GPU-only? Slow on big scenes? Destructive? That belongs in the
  design, and usually in a tooltip or `.hint`.

Write one paragraph: *the problem, in a user's words*. If you can't, you don't
understand the flag yet — go back to the CLI.

## 2. Design against the system

Read `client/src/style.css` and `client/index.html` first, every time. The app has a
small, consistent vocabulary; a new control either speaks it or looks bolted on.

| Shape | Use it for |
| --- | --- |
| `.field` | one labelled input, full width |
| `.field-row` of two `.field.half` | **related numerics** — the pairing is the idiom (SH iterations + encoder workers, LOD levels + keep %) |
| `.check` (or two in a `.field-row`) | booleans |
| `.group` / `.group.with-toggle` | a segment of related settings, optionally master-switched |
| `.hint`, `.hint.warn`, `.hint.danger` | consequences and caveats — not a tooltip's job |
| `.about-row`, `.chip`, `.badge` | read-only facts; never a `.field` for something you can't set |

Rules that hold across the app:

- **Never surface a raw sentinel.** `--lod -1` becomes a plain-language
  "environment / always-visible backdrop" affordance. The user should never type a
  magic number the CLI happens to use.
- **The tooltip names the flag.** Native `title=` on the control, flag in parens, plus
  the default and any caveat: `title="Worker threads for SOG encoding (--max-workers).
  Higher = faster on many-core machines; 0 = inline/serial. Default 4"`.
- **Defaults come from the CLI.** Read them out of `--help`; don't invent a nicer one.
  If the CLI's default is wrong for this app, that's a decision to state, not to bury.
- **Perf knobs are secondary.** Worker counts and thread caps sit beside their quality
  setting, never above it, and never as the first thing in a panel.
- **Gate visibility like the neighbours.** Rows that only apply to one format/mode
  toggle `.hidden` from `updateConvertRows()` (or the panel's equivalent), so the panel
  never shows a control that can't do anything.
- **Don't stack full-width fields** when two numbers belong together — that's what the
  `.half` pairing is for.

Then write down: the control, where it lives, its default, its visibility condition, its
tooltip text, and **the option you rejected and why**. The rejected option is the part
reviewers argue with, so it isn't optional.

## 3. Critique it adversarially

Before implementing, attack the design — for anything non-trivial, fan this out across
parallel sub-agents (discover · design-system fit · integration), each reporting
independently, then reconcile:

- Does it **look native**? Name the existing row it mirrors. If you can't name one,
  that's a smell.
- Does it **read** to someone who has never seen the CLI? Read the label and tooltip
  aloud with the flag name removed.
- What happens at the **edges** — empty input, 0, the max, a format that doesn't support
  it, a machine with no GPU?
- Does it **duplicate** an existing control, or make one ambiguous?
- Is the **cost visible** before the user commits to a long job?
- Does the design apply to **the branch you're actually editing** (not a stale sibling
  checkout)?

Verify the critique before trusting it: a sub-agent claiming "this control doesn't
exist" is wrong as often as it's right. Check the file.

## 4. Record it, then build

Post the design — problem, chosen shape, rejected option, cost — as an issue comment
before implementing, or in the PR body if it's small enough to have landed already.
Then hand off to **splat-studio-add-feature**.

**Stop and leave the design as a proposal, unimplemented**, if it needs a product
decision (what *should* this do?), changes what an existing control means, or spans more
than one panel. A well-argued proposal a human can say yes to is a good outcome; a
guessed-at feature that has to be unpicked is not.

## Smells

- A number in the UI that only makes sense if you've read `--help`.
- A new full-width field directly above or below an existing `.field-row` pair.
- A tooltip that restates the label instead of naming the flag and its default.
- A control that's always visible but only works for one output format.
- "It's just one more checkbox" — three of those is how a panel stops being legible.
