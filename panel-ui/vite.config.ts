import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The panel server owns /api/*; the Copilot runtime is a separate process.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The dev server has its own origin; the panel checks Origin on /api/query.
      // Strip it on the local proxy so the request looks like a same-origin call.
      "/api": {
        target: "http://127.0.0.1:4399",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => request.removeHeader("origin"));
        },
      },
      "/control": {
        target: "http://127.0.0.1:4398",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/control/u, "/api"),
      },
      "/events": {
        target: "http://127.0.0.1:4399",
        changeOrigin: true,
      },
    },
  },
});
