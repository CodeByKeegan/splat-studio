import { defineConfig } from 'vite';

export default defineConfig({
    root: 'client',
    build: {
        outDir: '../dist',
        emptyOutDir: true
    },
    server: {
        // PORT is injected by the Claude preview harness for secondary instances;
        // API_PORT lets a secondary instance point at its own Express server too
        port: Number(process.env.PORT) || 5173,
        proxy: {
            '/api': `http://127.0.0.1:${Number(process.env.API_PORT) || 5174}`,
            '/files': `http://127.0.0.1:${Number(process.env.API_PORT) || 5174}`,
            // the MCP editor-control relay is a WebSocket on the Express server
            '/editor-ws': { target: `ws://127.0.0.1:${Number(process.env.API_PORT) || 5174}`, ws: true }
        }
    }
});
