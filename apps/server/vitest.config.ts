import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

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
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
