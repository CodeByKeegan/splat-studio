# Splat Studio MCP server — setup guide

Splat Studio ships an [MCP](https://modelcontextprotocol.io) server that lets an AI agent
(Claude Desktop, Claude Code, or any MCP client) drive the app:

- **The headless pipeline** — convert, streamed LOD, WebP render, collision, region trim, analysis,
  and LOD suggestions. Works whenever Splat Studio is running. No special permission needed.
- **The live editor** — camera, panels, scene, gizmos, tools, dock layout. **Off by default**; you
  enable it with one toggle, and it's loopback-only and revocable instantly.

It talks to the running app over `127.0.0.1` and **never launches the app itself** — start Splat
Studio first.

---

## 1. Prerequisites

- **Splat Studio running** — either from source (`npm run dev`) or the installed desktop app.
- **Node.js 18+** on your PATH, to run the MCP server (`node --version`).
- An **MCP client** (Claude Desktop, Claude Code, etc.).

---

## 2. Get the MCP server

### Option A — from source (recommended while developing)

```bash
git clone https://github.com/CodeByKeegan/splat-studio
cd splat-studio
npm install            # installs the app
cd mcp-server
npm install            # installs the MCP server's deps (@modelcontextprotocol/sdk, zod)
```

The launch entry is **`<repo>/mcp-server/index.mjs`**. Note its absolute path — you'll point your
client at it. (On Windows, e.g. `C:\Users\you\splat-studio\mcp-server\index.mjs`.)

### Option B — the installed desktop app

The MCP server is **bundled inside the installed app**, at
`<install-dir>/resources/app/mcp-server/index.mjs` (its dependencies are bundled too). Use that path
in the config below. The app writes its chosen API port to `port.json` in its user-data folder, which
the MCP server reads automatically (see §5).

---

## 3. Connect your MCP client

### Claude Code (CLI)

```bash
# from anywhere — use the absolute path to index.mjs
claude mcp add splat-studio --scope user -- node /ABS/PATH/TO/splat-studio/mcp-server/index.mjs
```

Verify it registered:

```bash
claude mcp list
```

### Claude Desktop

Edit Claude Desktop's config file (create it if missing):

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Add a `splat-studio` entry:

```json
{
  "mcpServers": {
    "splat-studio": {
      "command": "node",
      "args": ["/ABS/PATH/TO/splat-studio/mcp-server/index.mjs"]
    }
  }
}
```

Save and **restart Claude Desktop**. You should see the `splat-studio` tools available.

### Any other MCP client

Run the server over **stdio** with:

- **command:** `node`
- **args:** `["/ABS/PATH/TO/splat-studio/mcp-server/index.mjs"]`
- **env (optional):** `SPLAT_API_PORT`, `SPLAT_API_HOST`, or `SPLAT_API_BASE` (see §5).

---

## 4. Enable live-editor control (optional)

Headless tools work as soon as the app is running. To let an agent drive the **live editor**:

1. In Splat Studio, open **Settings** (⚙ in the viewport toolbar) and pick the **Agent (MCP)** section.
2. Tick **"Allow agent (MCP) control of the editor."**
3. The status line shows the editor bridge as **connected · control ON**.

It's **off by default**, loopback-only, and you can untick it any time to revoke access instantly.
With it off, editor tools return `control-disabled` (headless tools are unaffected).

---

## 5. How the MCP server finds the app

Port resolution order:

1. **`SPLAT_API_PORT`** env var, if set.
2. **`port.json`** in the app's user-data folder (the packaged app writes this with its dynamic port).
3. **`5174`** — the default for `npm run dev`.

So from source you usually need no env at all. Overrides:

- `SPLAT_API_PORT=5174` — pin the port.
- `SPLAT_API_HOST=127.0.0.1` — change the host (stay on loopback).
- `SPLAT_API_BASE=http://127.0.0.1:5174` — set the full base URL.

---

## 6. Verify it works

With the app running, ask your agent (or call directly):

- `inspect(target: "health")` → `{ ok: true, cli: true }`
- `projects(action: "list")` → your project names
- (editor, consent on) `get_editor_state()` → the active panel, selection, camera, etc.

If the app isn't running, headless tools return `timeout` ("is the app running?") and editor tools
return `no-editor`.

---

## 7. What the agent can do (28 tools)

| Group | Tools |
|---|---|
| **Workspace / files** | `workspace` (get/set) · `projects` (list/create) · `files` (list/delete) · `import_file` |
| **Analysis / jobs** | `inspect` (stats/generator_params/lod_recipe/gpus/health/versions/editor_status) · `get_summary` · `jobs` (get/list/cancel/wait) · `suggest_lod_settings` |
| **Pipeline (jobs)** | `convert` · `build_lod` · `render_image` · `generate_collision` · `trim_region` |
| **Editor — viewport** | `camera` (get/set/mode/frame) · `viewport_screenshot` · `viewport_click` · `load_into_viewport` · `select_item` · `get_editor_state` |
| **Editor — scene/tools/dock** | `set_view_option` · `measure` · `set_origin` · `set_region` · `render_pose` · `set_collision_gizmo` · `history` (undo/redo) · `panel` · `layout` |

Plus **resources** (`splat-studio://projects`, `://jobs`, `://files/{project}`) and **prompts**
(`optimize_for_web`, `setup_collision`, `inspect_splat`, `clean_up_scan`, `scale_to_real_world`).

Every tool carries MCP behaviour annotations (read-only / destructive hints), so clients
can prompt appropriately — only `files` (delete) and `import_file` (overwrite) are
flagged destructive.

**Step-by-step recipes** — common and uncommon — live in [MCP_WORKFLOWS.md](MCP_WORKFLOWS.md).

**Jobs are fire-and-poll:** `convert`/`build_lod`/`render_image`/`generate_collision`/`trim_region`/`get_summary`
return `{ jobId }`. Wait with `jobs(action: "wait", id, timeout_ms)`, then read it with
`jobs(action: "get", id)`.

**Errors** are always `{ error, message }` with `error` one of: `no-editor`, `control-disabled`,
`bad-input`, `job-failed`, `not-found`, `timeout`, `gpu-required`.

---

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Headless tools return `timeout` ("is the app running?") | Splat Studio isn't running — start it. The MCP server re-resolves the port on the next call (env → `port.json` → 5174), so it recovers automatically once the app is up. |
| Editor tools return `no-editor` | The app is up but its editor bridge isn't connected yet (give it a second after launch), or no GUI window is open. |
| Editor tools return `control-disabled` | Turn on **Settings → Agent control (MCP)**. Note: **switching workspaces resets this to off.** Probe without consent via `inspect(target: "editor_status")`. |
| `generate_collision` returns `{ refused: true }` | The preflight estimates the voxelization would overflow the marching-cubes vertex limit. Raise `voxelSize`, crop with `filterBox`/`filterSphere`, or pass `overridePreflight: true`. |
| `gpu-required` | Voxelization/collision and `--filter-cluster`/floater removal need a GPU. SOG encoding can fall back with `device: "cpu"`. |
| Client can't find the server | Use the **absolute** path to `mcp-server/index.mjs`, and make sure `node` is on PATH. |

---

Tutorials for common and uncommon workflows: [MCP_WORKFLOWS.md](MCP_WORKFLOWS.md). For the
agent-facing playbooks (operating contract, recipes, extending the surface), see the
`splat-studio-mcp` and `splat-studio-workflows` skills in `.claude/skills/`. The authoritative
design lives on the project's internal task board, not in markdown.
