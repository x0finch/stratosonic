import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";

/**
 * `TEST_MIGRATIONS` is supplied by vitest.config.ts and exists only under test.
 * It is read through a local type here rather than merged into the generated
 * `Cloudflare.Env`, so nothing under src/ can reference a test-only binding and
 * still typecheck.
 */
interface TestBindings {
  TEST_MIGRATIONS: D1Migration[];
}

const { TEST_MIGRATIONS } = env as unknown as TestBindings;

await applyD1Migrations(env.DB, TEST_MIGRATIONS);
