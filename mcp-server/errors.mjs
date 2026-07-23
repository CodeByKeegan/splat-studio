// Universal error shape + HTTP/job-failure mapping shared by every tool.
// Closed set of 7 codes; tools never invent new codes.

export const ERR = {
    NO_EDITOR: 'no-editor',
    CONTROL_DISABLED: 'control-disabled',
    BAD_INPUT: 'bad-input',
    JOB_FAILED: 'job-failed',
    NOT_FOUND: 'not-found',
    TIMEOUT: 'timeout',
    GPU_REQUIRED: 'gpu-required'
};

// thrown by http.mjs on a non-2xx response
export class HttpError extends Error {
    constructor(status, body, url) {
        super(typeof body === 'string' ? body : body?.error || `HTTP ${status}`);
        this.status = status;
        this.body = body;
        this.url = url;
    }
}

// thrown by http.mjs when the API is unreachable (app not running)
export class ConnError extends Error {
    constructor(url, cause) {
        super(`Splat Studio is not running at ${url}`);
        this.url = url;
        this.cause = cause;
    }
}

const serverText = (body) =>
    body && typeof body === 'object' ? body.error || body.message || '' : typeof body === 'string' ? body : '';

const tail = (s, n = 600) => (s || '').slice(-n).trim();

// a 400 that is really a "missing resource" guard reads as not-found
const MISSING_RE = /no such|not found|input not found|does not exist/i;

// map a HEADLESS HTTP failure to the universal shape (route/status based)
export function mapHttpError(err) {
    if (err instanceof ConnError) {
        return { error: ERR.TIMEOUT, message: `${err.message} — start Splat Studio, then retry.` };
    }
    if (err instanceof HttpError) {
        const text = serverText(err.body) || err.message;
        if (err.status === 404) return { error: ERR.NOT_FOUND, message: text };
        if (err.status === 409) return { error: ERR.BAD_INPUT, message: text }; // create_project conflict
        if (err.status === 400) return { error: MISSING_RE.test(text) ? ERR.NOT_FOUND : ERR.BAD_INPUT, message: text };
        return { error: ERR.BAD_INPUT, message: text || `HTTP ${err.status}` };
    }
    const msg = err?.message || String(err);
    return { error: MISSING_RE.test(msg) ? ERR.NOT_FOUND : ERR.BAD_INPUT, message: msg };
}

// map an EDITOR-relay failure (POST /api/editor/command uses distinct statuses)
export function mapEditorError(err) {
    if (err instanceof ConnError) return { error: ERR.NO_EDITOR, message: 'Splat Studio is not running.' };
    if (err instanceof HttpError) {
        const text = serverText(err.body) || err.message;
        if (err.status === 409) return { error: ERR.NO_EDITOR, message: text || 'No editor is connected to Splat Studio.' };
        if (err.status === 403) return { error: ERR.CONTROL_DISABLED, message: text || 'Editor control is off — enable it in the MCP settings tab.' };
        if (err.status === 504) return { error: ERR.TIMEOUT, message: text || 'The editor did not respond in time.' };
        if (err.status === 400) return { error: ERR.BAD_INPUT, message: text };
        return { error: ERR.BAD_INPUT, message: text || `HTTP ${err.status}` };
    }
    return { error: ERR.BAD_INPUT, message: err?.message || String(err) };
}

// a failed job whose log smells of a GPU/device problem -> gpu-required, else job-failed
const GPU_RE = /webgpu|gpu|adapter|dawn|device lost|d3d|vulkan|no suitable|filter-cluster|requestAdapter|DXGI/i;
export function classifyJobFailure(job) {
    const log = job?.log || '';
    if (GPU_RE.test(log)) return { error: ERR.GPU_REQUIRED, message: tail(log) || 'A GPU is required for this operation.' };
    return { error: ERR.JOB_FAILED, message: tail(log) || `Job ${job?.id ?? ''} failed.` };
}

// ---- CallToolResult helpers ----
export const okResult = (data) => ({
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }]
});
export const failResult = (shape) => ({
    content: [{ type: 'text', text: JSON.stringify(shape, null, 2) }],
    isError: true
});
export const imageResult = (base64Png, meta) => ({
    content: [
        { type: 'image', data: base64Png, mimeType: 'image/png' },
        ...(meta ? [{ type: 'text', text: JSON.stringify(meta) }] : [])
    ]
});
