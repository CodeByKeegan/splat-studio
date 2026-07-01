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
