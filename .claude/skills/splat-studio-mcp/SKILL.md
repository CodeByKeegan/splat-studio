---
name: splat-studio-mcp
description: Drive Splat Studio from an AI agent via its MCP server — the headless splat-transform pipeline (always available) and the live PlayCanvas editor (consent-gated). Use when operating Splat Studio through MCP tools, wiring an agent to it, or extending the MCP surface.
---

# Driving Splat Studio over MCP

The MCP server lives in `mcp-server/` (stdio, `@modelcontextprotocol/sdk`). It is a thin
client over the existing loopback API (`server/index.mjs`) plus a WebSocket relay for the
live editor. **It requires Splat Studio to already be running** and never launches it.

## Connecting a client

Point any MCP client at the launched entry, with the API port if it isn't the default 5174:

```json
{
  "mcpServers": {
    "splat-studio": {
      "command": "node",
      "args": ["<repo>/mcp-server/index.mjs"],
      "env": { "SPLAT_API_PORT": "5174" }
    }
  }
}
```

Port resolution: `SPLAT_API_PORT` env → `userData/port.json` (written by the packaged app) → `5174`.
`SPLAT_API_BASE` / `SPLAT_API_HOST` override for non-standard setups. When a call finds the app
unreachable, the base is **re-resolved once and retried** — so starting the app after the MCP
server (or the packaged app picking a new dynamic port) recovers without a restart.

## The 28 tools

**Headless (always available, no consent):** `workspace` (get|set — set can `create`) ·
`projects` (list|create) · `files` (list|delete) · `import_file` ·
`inspect` (stats|generator_params|gpus|health|versions|**editor_status**) · `get_summary` ·
`jobs` (get|list|cancel|wait) · `convert` · `build_lod` · `render_image` · `generate_collision` ·
`trim_region` · `suggest_lod_settings`.

**Editor (consent-gated — see below):** `camera` (get|set|mode|frame) · `viewport_screenshot`
(`max_width` to downscale) · `viewport_click` · `load_into_viewport` (load|clear) ·
`set_view_option` (bounds|skybox|collision_style|layer) · `select_item` · `get_editor_state` ·
`measure` (measure|set_length — returns `{a,b,distance,scale?}`, accepts `points`) ·
`set_origin` (returns the CLI `translate`) · `set_region` (crop_box|crop_sphere|collision_region) ·
`render_pose` · `set_collision_gizmo` (seed|capsule) · `history` (get|undo|redo) ·
`panel` (open|close) · `layout` (get|set|reset).

**Resources:** `splat-studio://projects`, `splat-studio://jobs`, `splat-studio://files/{project}`.
**Prompts:** `optimize_for_web`, `setup_collision`, `inspect_splat`, `clean_up_scan`,
`scale_to_real_world`.

All tools carry MCP annotations: `files` and `import_file` are the only destructive ones
(delete / overwrite); `inspect`, `get_editor_state`, `viewport_screenshot`,
`suggest_lod_settings` are read-only.

## How to operate it

- **Jobs are fire-and-poll.** `convert`/`build_lod`/`render_image`/`generate_collision`/`trim_region`/`get_summary`
  return `{jobId}`. Then `jobs(action:"wait", id, timeout_ms)` until done, and `jobs(action:"get", id)` for the
  full record (incl. log). On timeout the job keeps running server-side. Jobs run concurrently as
  subprocesses — don't overlap GPU-heavy ones.
- **Probe before editor work.** `inspect(target:"editor_status")` → `{connected, controlEnabled}`
  needs no consent. Editor control is OFF by default (the user enables "Allow agent (MCP) control
  of the editor" in Settings) and **resets to OFF on every workspace switch**. With control off,
  editor tools return `control-disabled`; with the app down, headless tools return `timeout` and
  editor tools `no-editor`.
- **Errors are always `{error,message}`** with `error` in: `no-editor`, `control-disabled`, `bad-input`,
  `job-failed`, `not-found`, `timeout`, `gpu-required`.
- **Coordinate frames matter.** `camera` + `viewport_click` + `measure` are **viewer-world**.
  Everything the CLI consumes — `convert` transforms/filters, `trim_region`, `set_region` (all
  targets), `render_image` cameras, `render_pose`, `set_origin`'s returned translate — is the
  **splat frame**: viewer `[x,y,z]` → `[x,-y,-z]` (R_x(180)). Sole exception:
  `generate_collision(seedPos)` / `set_collision_gizmo(seed)` are **voxel space**: viewer →
  `[-x,y,-z]` (R_y(180)). Tool descriptions restate the frame per tool; prefer the editor tools'
  returned values over hand conversion.
- **GPU.** `generate_collision` and `--filter-cluster`/floater removal need the GPU → `gpu-required` if
  unavailable. SOG encoding has a CPU fallback (`device:"cpu"`).
- **Editor reads → headless writes.** The scale/origin flows read derived values from the editor
  (`measure` → `scale`, `set_origin` → `translate`) and apply them via `convert` — reproducible and
  no GUI Apply click needed.

## Common flows

Recipes with exact calls live in **`splat-studio-workflows`** (agent playbook) and
`docs/MCP_WORKFLOWS.md` (user tutorials). Headlines:

- **Web-ready:** `convert(format:"sog")`, or `suggest_lod_settings` → `build_lod(mode:"decimate")` for >~2M gaussians.
- **Collision:** `generate_collision` (seedPos/carve/region; heed the `{refused,preflight}` guard) → `jobs(wait)`.
- **Carve/crop:** `trim_region` headlessly, or stage the region live with `set_region` + `viewport_screenshot` first.
- **Scale/origin:** editor `measure`/`set_origin` for the numbers, `convert` to apply.

## Extending it

Tool modules are `mcp-server/tools/*.mjs` (`files`/`analysis`/`convert`/`editor`/`phase3`), each
`register(server)` calling `server.registerTool` with a Zod schema **and an annotations preset
from `_wrap.mjs` (`RO`/`SAFE`/`DEL`)**. Headless tools wrap a route via `http.mjs`; editor tools
forward a `{name,params}` command via `POST /api/editor/command` and a matching handler in
`client/src/main.ts`'s `mcpHandlers` (which drives the **real** GUI actions so gizmos + form
fields + persistence stay in sync — keep tool descriptions honest about what the handler actually
does). The error contract + job model live in `mcp-server/errors.mjs`. Run `npm run test:mcp`
after changes (and `npm run typecheck` if `client/` was touched); keep the tool-count check in
`tests/mcp-e2e.mjs` and the docs (`docs/MCP_SETUP.md` §7, `docs/MCP_WORKFLOWS.md`) in sync.
The authoritative design is the Asana MCP epic, not markdown.
