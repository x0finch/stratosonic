import { createApp } from "./app";
import type { Env } from "./env";
import { SCAN_DRIVER_INSTANCE } from "./scanner/driver";
import { ensureInitialSetup } from "./setup/initial-setup";

const app = createApp();

/** The Durable Object that drives the Scan (ADR-0004, #31). */
export { ScanDriver } from "./scanner/driver";

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
   * wrangler.jsonc, but the cron no longer does the ingesting: it pokes the
   * scan driver and returns (#31).
   *
   * The reason is the clock. One step of the Scan is all the free plan's 50
   * subrequests buy, and cron cannot tick faster than once a minute, so a
   * pass driven by cron alone takes days over a large library. The driver is
   * a Durable Object whose alarm runs one step and schedules the next a
   * second later, which turns the same steps into minutes. A cron invocation
   * also has 10 ms of CPU, which is no place to parse a tag; an alarm
   * invocation has far more (#30).
   *
   * So the schedule now decides only how often a pass *starts*. A poke while
   * a pass is in flight is a no-op, and the driver runs the playlist import
   * itself once the scan's pass completes, in that order (#17), for the same
   * reason as before: an `.m3u` entry can only resolve to a Track the scan
   * has already indexed.
   *
   * The bootstrap runs here rather than in the driver, because a cron run can
   * reach a new deployment before any client does and the import needs an
   * admin to own the playlists it creates; it always precedes the first
   * alarm. The poke is stamped with the cron's scheduled time rather than the
   * wall clock, so a pass whose steps are spread over minutes still records
   * the instant it began.
   *
   * A failed poke is logged and swallowed rather than allowed to fail the
   * invocation: the pass the driver is already running is untouched by it,
   * and the next cron run pokes again.
   */
  async scheduled(controller, env) {
    await ensureInitialSetup(env);

    try {
      const driver = env.SCAN_DRIVER.get(env.SCAN_DRIVER.idFromName(SCAN_DRIVER_INSTANCE));
      const outcome = await driver.start(controller.scheduledTime);
      console.log(
        outcome === "started"
          ? "scan driver: a pass has started"
          : "scan driver: a pass is already running",
      );
    } catch (error) {
      console.error("scan driver: the poke failed; the next cron run pokes again", error);
    }
  },
} satisfies ExportedHandler<Env>;
