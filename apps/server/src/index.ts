import { createApp } from "./app";
import type { Env } from "./env";
import { ensureInitialSetup } from "./setup/initial-setup";

const app = createApp();

export default {
  async fetch(request, env, ctx) {
    // The first request an isolate serves may be the first request this
    // deployment has ever seen, so the admin user is created here rather than
    // from a setup step no one would run. Later requests in the same isolate
    // find the answer cached.
    await ensureInitialSetup(env);

    return app.fetch(request, env, ctx);
  },
  // Library ingestion runs on a cron schedule (ADR-0004); it is implemented in
  // a later phase. The bootstrap runs here too, because a cron run can reach a
  // new deployment before any client does.
  async scheduled(_controller, env) {
    await ensureInitialSetup(env);
  },
} satisfies ExportedHandler<Env>;
