import { defineConfig } from "vitest/config";

// The routing tests run in Node rather than in the Workers pool: they start the
// Worker behind its asset router with Wrangler's test harness and send it
// requests from outside, as a browser or a Subsonic client would. The same
// harness runs the bundle the deploy workflow builds, with the release defined
// (server-version.test.ts).
export default defineConfig({
  test: {
    include: ["test/routing/**/*.test.ts"],
    // Starting the harness bundles the Worker and boots workerd.
    hookTimeout: 60_000,
  },
});
