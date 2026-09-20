import { defineConfig } from "drizzle-kit";

// Migrations are generated here and applied to D1 with
// `wrangler d1 migrations apply` from apps/server, whose wrangler.jsonc points
// its `migrations_dir` at packages/db/migrations. Tests apply the same files
// through the vitest-pool-workers `applyD1Migrations` helper.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
