import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Migrations read from packages/db, injected by vitest.config.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
