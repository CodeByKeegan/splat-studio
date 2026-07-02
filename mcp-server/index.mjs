#!/usr/bin/env node
// Splat Studio MCP server (stdio). Exposes the headless splat-transform pipeline
// and the live PlayCanvas editor to AI agents. REQUIRES Splat Studio to be running;
// it never launches the app. Editor tools are consent-gated (off by default).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BASE } from './http.mjs';
import * as files from './tools/files.mjs';
import * as analysis from './tools/analysis.mjs';
import * as convert from './tools/convert.mjs';
import * as editor from './tools/editor.mjs';
import * as phase3 from './tools/phase3.mjs';

const INSTRUCTIONS = [
    'Drive Splat Studio (a GUI over @playcanvas/splat-transform) headlessly and, with consent, control its live editor.',
    'Splat Studio must already be running on the same machine; this server connects to its loopback API and never launches it.',
    'Headless tools (workspace, projects, files, import_file, inspect, get_summary, jobs, convert, build_lod, render_image, generate_collision, trim_region, suggest_lod_settings) work whenever the app is up.',
    'Long operations are jobs: convert/build_lod/render_image/generate_collision/trim_region/get_summary return {jobId}; poll with jobs(action="wait") then jobs(action="get").',
    'Editor tools require the consent toggle in the app\'s Settings panel; with it off they return error "control-disabled". Probe first with inspect(target:"editor_status") — it needs no consent. Switching workspace resets consent to OFF.',
    'Every failure is {error,message} with error in: no-editor, control-disabled, bad-input, job-failed, not-found, timeout, gpu-required.',
    'Spatial frames: camera/viewport_click/measure are viewer-world. Everything the CLI consumes — convert/trim/collision region boxes+spheres, set_region (all targets), render cameras (render_image/render_pose), set_origin\'s translate — is the SPLAT frame: viewer [x,y,z] -> [x,-y,-z]. Sole exception: generate_collision seedPos / set_collision_gizmo(seed) use voxel space: viewer [x,y,z] -> [-x,y,-z].'
].join(' ');

const server = new McpServer(
    { name: 'splat-studio', version: '0.2.0' },
    { instructions: INSTRUCTIONS }
);

// headless half (always available)
files.register(server);
analysis.register(server);
convert.register(server);
// editor half (consent-gated; needs the GUI running with control enabled)
editor.register(server);
// phase 3: opinionated layer (suggest_lod_settings) + MCP resource surface
phase3.register(server);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the JSON-RPC channel; logs go to stderr only.
console.error(`[splat-studio-mcp] ready — API base ${BASE}`);
