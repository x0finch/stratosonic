import { createApp } from "./app";
import type { Env } from "./env";
import { runScan } from "./scanner/scan";
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
  /**
   * Library ingestion runs on a cron schedule (ADR-0004), declared in
   * wrangler.jsonc. One run is one bounded step of the Scan, which resumes
   * from where the last one stopped; the schedule is what makes the pass
   * finish.
   *
   * The bootstrap runs here too, because a cron run can reach a new
   * deployment before any client does. The scan is stamped with the cron's
   * scheduled time rather than the wall clock, so a run that starts late does
   * not stamp its rows later than the pass it belongs to.
   *
   * The playlist import (#17) joins this handler after the scan.
   */
  async scheduled(controller, env) {
    await ensureInitialSetup(env);

    const run = await runScan(env, new Date(controller.scheduledTime));
    console.log(
      run.completed
        ? `scan: pass complete, ${JSON.stringify(run.totals)}`
        : `scan: step complete, ${JSON.stringify(run.counts)}`,
    );
  },
} satisfies ExportedHandler<Env>;
