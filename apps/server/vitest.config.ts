import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";
import { PINNED_ENV } from "./test/pinned-env";

// Resolved against this project directory, which is Vitest's working directory.
const migrationsDir = "../../packages/db/migrations";

export default defineConfig(async () => {
  // Tests run against a real D1 carrying the same migrations that
  // `wrangler d1 migrations apply` would run in production.
  const migrations = await readD1Migrations(migrationsDir);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // The Worker's secrets (`wrangler secret put` in production) and its
          // plain vars, supplied the same way the runtime sees them, as plain
          // bindings. All of them are pinned, so that a local `.dev.vars`,
          // which the pool loads through `configPath`, cannot change a result
          // (test/pinned-env.ts).
          bindings: {
            TEST_MIGRATIONS: migrations,
            ...PINNED_ENV,
          },
          // A second, empty database, which no setup file migrates: a test
          // migrates it part of the way, writes the rows a deployed server
          // would have, then applies the rest (test/migration-0008.test.ts).
          d1Databases: ["MIGRATION_DB"],
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // Run in Node by vitest.routing.config.ts, not inside the Workers pool.
      exclude: [...configDefaults.exclude, "test/routing/**"],
    },
  };
});
