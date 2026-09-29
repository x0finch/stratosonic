import path from "node:path";
import { defineConfig } from "vitest/config";

// The console's unit tests: plain modules under src/lib, in Node. The screens
// themselves are checked in a browser (scripts/walkthrough.mjs).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
