import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Where `wrangler dev` (apps/server) listens by default.
const WORKER_ORIGIN = "http://localhost:8787";

// https://vite.dev/config/
export default defineConfig({
  // The router plugin generates src/routeTree.gen.ts from src/routes and must
  // run before the React plugin (tanstack.com/router, "Installation with Vite").
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  // In development the console is served by Vite, and the paths the Worker
  // answers first in production (`assets.run_worker_first` in
  // apps/server/wrangler.jsonc) are forwarded to `wrangler dev`, so the
  // console talks to the same origin either way.
  server: {
    proxy: {
      "/api": WORKER_ORIGIN,
      "/rest": WORKER_ORIGIN,
      "/share": WORKER_ORIGIN,
    },
  },
});
