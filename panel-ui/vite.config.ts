import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The panel server owns /api/*; the Copilot runtime is a separate process.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4399",
      "/events": {
        target: "http://127.0.0.1:4399",
        changeOrigin: false,
      },
    },
  },
});
