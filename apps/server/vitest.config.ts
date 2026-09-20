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
          // `INITIAL_PASSWORD` and `PASSWORD_ENCRYPTION_KEY` are Worker secrets
          // in production (`wrangler secret put`); tests supply them the same
          // way the runtime sees them, as plain bindings.
          bindings: {
            TEST_MIGRATIONS: migrations,
            INITIAL_USER: "admin",
            INITIAL_PASSWORD: "sesame",
            PASSWORD_ENCRYPTION_KEY: "test-password-encryption-key",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
