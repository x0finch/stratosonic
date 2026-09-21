import { createApp } from "./app";
import type { Env } from "./env";
import { importPlaylists } from "./playlists/import";
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
   * The playlist import runs after the scan, in the same invocation and in
   * that order (#17): an `.m3u` entry can only resolve to a Track the scan
   * has already indexed, and a playlist imported against a half-indexed
   * library is put right by the next pass, which re-reads every file.
   *
   * Each step that throws is logged and swallowed rather than allowed to fail
   * the invocation, and each is caught on its own. Both commit each listing
   * page with its own cursor, so whatever they had finished is already
   * durable and the next cron run resumes there; letting the error out would
   * add nothing but a failed invocation in the dashboard, and would skip the
   * work that follows - which for the scan is the import, and the import has
   * its own reason to run even when the scan could not.
   */
  async scheduled(controller, env) {
    await ensureInitialSetup(env);

    const now = new Date(controller.scheduledTime);

    try {
      const run = await runScan(env, now);
      console.log(
        run.completed
          ? `scan: pass complete, ${JSON.stringify(run.totals)}`
          : `scan: step complete, ${JSON.stringify(run.counts)}`,
      );
    } catch (error) {
      console.error("scan: the run failed; it resumes from its cursor next run", error);
    }

    try {
      const imported = await importPlaylists(env, now);
      console.log(
        imported.completed
          ? `playlists: pass complete, ${JSON.stringify(imported.totals)}`
          : `playlists: step complete, ${JSON.stringify(imported.counts)}`,
      );
    } catch (error) {
      console.error("playlists: the run failed; it resumes from its cursor next run", error);
    }
  },
} satisfies ExportedHandler<Env>;
