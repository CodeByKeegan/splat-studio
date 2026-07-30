// Vite build/dev-server config: client/ is the app root; /api, /files and the
// editor WebSocket proxy to the Express server during dev.
import { defineConfig } from 'vite';

export default defineConfig({
    root: 'client',
    build: {
        outDir: '../dist',
        emptyOutDir: true
    },
    server: {
        // PORT/API_PORT let a second dev instance run side-by-side against its
        // own Express server
        port: Number(process.env.PORT) || 5173,
        proxy: {
            '/api': `http://127.0.0.1:${Number(process.env.API_PORT) || 5174}`,
            '/files': `http://127.0.0.1:${Number(process.env.API_PORT) || 5174}`,
            // the MCP editor-control relay is a WebSocket on the Express server
            '/editor-ws': { target: `ws://127.0.0.1:${Number(process.env.API_PORT) || 5174}`, ws: true }
        }
    }
});
