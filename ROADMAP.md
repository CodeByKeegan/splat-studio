# Roadmap

Where Splat Studio is headed. This is a direction, not a set of promises — items
can move, merge, or drop as the tool and [`@playcanvas/splat-transform`](https://github.com/playcanvas/splat-transform)
evolve. Ideas and disagreement welcome: open an issue.

Legend: ✅ shipped · 🔜 near-term · 🧭 exploring

## ✅ Shipped

The foundation is in place and in daily use:

- **Convert** — `.ply` / `.compressed.ply` / `.sog` (bundled + unbundled) / `.spz`, and
  **streamed LOD SOG** for large scenes, with spherical-harmonic compression controls.
- **Collision** — voxelize a splat to a watertight `.collision.glb` with indoor / outdoor /
  object presets.
- **3D viewer** — PlayCanvas renderer with fly/orbit cameras, scene hierarchy, gizmos,
  collision-overlay styles, voxel-octree display, and skybox.
- **Edit from the viewport** — measure-to-scale and set-origin tools; direct scale apply.
- **Analyze** — gaussian count, extent, NaN/Inf flags, per-column histograms; `.mjs`
  procedural generators as first-class inputs.
- **Render to WebP** — pinhole or 360° equirect, with depth-of-field and motion-blur.
- **Dockable editor** — movable/floatable panels, layouts saved per workspace.
- **Self-updating desktop app** — Windows build that updates itself from GitHub Releases.
- **MCP server** — drive the headless pipeline and (with consent) the live editor from an AI agent.
- **Autonomous maintenance** — a scheduled routine tracks upstream releases, wires new CLI
  flags into the GUI, runs the regression suite, and opens a PR.

## 🔜 Near-term

What's actively being built or next up:

- **Release channels** — a **beta** channel (from `dev`) alongside **stable** (from `main`),
  switchable in-app, so early adopters can opt in without affecting stable users.
- **Smoother in-app updates** — download and stage updates quietly; apply on next quit
  instead of prompting every launch. Check-for-updates and channel choice live on a
  Settings page.
- **Public documentation site** — the user guide and MCP docs published via GitHub Pages,
  kept in sync from the repo.
- **Continuous CLI coverage** — keep pace with new `splat-transform` flags as they ship
  (handled largely by the maintenance routine).

## 🧭 Exploring

Bigger bets, not yet committed — feedback shapes these:

- **Cross-platform builds** — macOS and Linux. The `splat-transform` CLI's WebGPU/Dawn
  path is cross-platform; the packaging, bundled-runtime staging, and viewer would need
  platform work.
- **Signed installers** — Authenticode signing to clear Windows SmartScreen warnings.
- **Big-scene performance** — smarter streaming and memory management for multi-hundred-
  million-gaussian scans.
- **Batch / headless pipeline** — a scriptable, CI-friendly mode for bulk conversion and
  render jobs without the GUI.
- **Plugin surface** — let third parties add formats, generators, or viewer tools.
- **Deeper viewer** — animation/timeline, camera paths, and richer scene composition.
- **Expanded MCP surface** — more editor control and higher-level "recipe" tools for agents.

Have a use case that isn't here? [Open an issue](https://github.com/CodeByKeegan/splat-studio/issues)
— real workflows drive this list.
