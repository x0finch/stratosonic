import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";

/**
 * This setup file runs once per test file, before its tests.
 *
 * Storage isolation, verified against @cloudflare/vitest-pool-workers 0.22:
 * D1 and R2 state is isolated PER TEST FILE but SHARED between the tests within
 * a file, and the pool no longer exposes an `isolatedStorage` option to change
 * that. A test that needs a pristine database therefore has to live in its own
 * file, or clean up after itself in `beforeEach`.
 */

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
