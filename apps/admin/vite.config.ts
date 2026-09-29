import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

// Where `wrangler dev` (apps/server) listens: its default, unless
// WORKER_ORIGIN names another.
const WORKER_ORIGIN = process.env.WORKER_ORIGIN ?? "http://localhost:8787";

// The Worker takes a console POST only from its own origin: Better Auth and
// the console API compare the `Origin` the browser sends, Vite's, with the
// origin of the request URL. `wrangler dev` builds that URL from the `Host`
// header, so the proxy passes the browser's on unchanged (`changeOrigin`
// false, which the string shorthand would turn on), and the Worker sees the
// console's origin exactly as when it serves the console itself.
const toWorker: ProxyOptions = { target: WORKER_ORIGIN, changeOrigin: false };

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
      "/api": toWorker,
      "/rest": toWorker,
      "/share": toWorker,
    },
  },
});
