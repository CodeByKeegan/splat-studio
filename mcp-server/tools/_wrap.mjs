// Shared helpers for tool modules.
import { okResult, failResult, mapHttpError } from '../errors.mjs';

// Wrap a headless handler: its return value becomes an ok result; any thrown
// HttpError/ConnError/Error becomes the universal {error,message} shape.
export const headless = (fn) => async (args, extra) => {
    try {
        return okResult(await fn(args, extra));
    } catch (e) {
        return failResult(mapHttpError(e));
    }
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tool annotation presets (MCP behaviour hints; everything is local/loopback).
export const RO = { readOnlyHint: true, openWorldHint: false };                    // pure read
export const SAFE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }; // writes, never deletes user data
export const DEL = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };   // can delete/overwrite user data
