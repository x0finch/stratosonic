import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// SPIKE #86: `import.meta.url` is typed only by Node's types, which this
// project does not load; the config loader substitutes it literally.
declare global {
  interface ImportMeta {
    readonly url: string;
  }
}

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
          // SPIKE #86: an empty second database, so a test can apply the
          // migrations up to 0007, seed users, and watch 0008 backfill them.
          d1Databases: ["MIGRATION_DB"],
        },
      }),
    ],
    resolve: {
      // SPIKE #86: Better Auth's default scrypt hasher, swapped for a counting
      // wrapper around the real one (test/scrypt-probe.ts).
      alias: [
        {
          find: /^@better-auth\/utils\/password$/,
          replacement: new URL("./test/scrypt-probe.ts", import.meta.url).pathname,
        },
      ],
    },
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // SPIKE #86: run Better Auth through Vite's module graph, so the alias
      // above reaches its imports.
      server: { deps: { inline: [/better-auth/] } },
    },
  };
});
