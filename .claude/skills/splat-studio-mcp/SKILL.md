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
`SPLAT_API_BASE` / `SPLAT_API_HOST` override for non-standard setups.

## The 26 tools (consolidated from 51)

**Headless (always available, no consent):** `projects` (list|create) · `files` (list|delete) ·
`import_file` · `inspect` (stats|generator_params|gpus|health|versions) · `get_summary` ·
`jobs` (get|list|cancel|wait) · `convert` · `build_lod` · `render_image` · `generate_collision` ·
`trim_region` · `suggest_lod_settings`.

**Editor (consent-gated — see below):** `camera` (get|set|mode|frame) · `viewport_screenshot` ·
`viewport_click` · `load_into_viewport` (load|clear) · `set_view_option` (bounds|skybox|collision_style|layer) ·
`select_item` · `get_editor_state` · `measure` · `set_origin` · `set_region` (crop_box|crop_sphere|collision_region) ·
`render_pose` · `set_collision_gizmo` (seed|capsule) · `panel` (open|close) · `layout` (get|set|reset).

**Resources:** `splat-studio://projects`, `splat-studio://jobs`, `splat-studio://files/{project}`.

## How to operate it

- **Jobs are fire-and-poll.** `convert`/`build_lod`/`render_image`/`generate_collision`/`trim_region`/`get_summary`
  return `{jobId}`. Then `jobs(action:"wait", id, timeout_ms)` until done, and `jobs(action:"get", id)` for the
  full record (incl. log). On timeout the job keeps running server-side.
- **Editor control is OFF by default.** Editor tools return `control-disabled` until the user enables
  "Allow agent (MCP) control of the editor" in the app's Settings panel. With the app not running, editor
  tools return `no-editor` and headless tools return `timeout` ("is the app running?").
- **Errors are always `{error,message}`** with `error` in: `no-editor`, `control-disabled`, `bad-input`,
  `job-failed`, `not-found`, `timeout`, `gpu-required`.
- **Coordinate frames matter.** `camera` + `viewport_click` results are **viewer-world**.
  `render_pose`, `set_collision_gizmo(seed)`, and `set_region(collision_region)` are **CLI space**
  (Y-up; x and z negated vs the viewer). `set_region(crop_box|crop_sphere)` and `trim_region` use the
  `-B/-S` action space. Tool descriptions restate the frame per tool.
- **GPU.** `generate_collision` and `--filter-cluster`/floater removal need the GPU → `gpu-required` if
  unavailable. SOG encoding has a CPU fallback (`device:"cpu"`).

## Common flows

- **Optimize a splat for the web:** `convert` to `sog`, or `suggest_lod_settings` → `build_lod(mode:"decimate")`.
- **Generate collision:** `generate_collision` (optionally with a `seedPos`/`carve`/region), then
  `jobs(wait)`, then (editor) `load_into_viewport` the `collision.collision.glb`.
- **Carve/crop:** `trim_region` (headless) for a one-shot, or set up the region live with
  `set_region` + `viewport_screenshot` to confirm before applying.

## Extending it

Tool modules are `mcp-server/tools/*.mjs` (`files`/`analysis`/`convert`/`editor`/`phase3`), each
`register(server)` calling `server.registerTool` with a Zod schema. Headless tools wrap a route via
`http.mjs`; editor tools forward a `{name,params}` command via `POST /api/editor/command` and a matching
handler in `client/src/main.ts`'s `mcpHandlers` (which drives the **real** GUI actions so gizmos + form
fields + persistence stay in sync). The error contract + job model live in `mcp-server/errors.mjs`.
Run `npm run test:mcp` after changes. The authoritative design is the Asana MCP epic, not markdown.
