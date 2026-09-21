/**
 * The scan driver: the Durable Object that carries a pass to completion.
 *
 * ## Why a Durable Object
 *
 * A step of the Scan is bounded by the free plan's **50 subrequests per
 * invocation** (`scan.ts`), which is about six tracks. Cron is the coarsest
 * clock Workers has - one tick a minute at best - so a library of 5,000
 * tracks driven by cron alone is days away from its first complete pass
 * (#31).
 *
 * A Durable Object alarm is the fine clock the same work needs: the handler
 * runs one step and, if the pass is not finished, schedules the next alarm a
 * second later. The step budget is unchanged - an alarm invocation is a
 * Worker invocation, with the same 50 subrequests - but the steps run back to
 * back, so 5,000 tracks is about 840 steps and a quarter of an hour rather
 * than nine days.
 *
 * The object drives; it does not store. D1's `property` table remains the
 * source of truth for what a pass has done (`scanner/state.ts`,
 * `playlists/state.ts`), because that state has to be readable by the `fetch`
 * handler and has to survive this object being reset. What lives in Durable
 * Object storage is only the driver's own bookkeeping: whether a pass is in
 * flight, which phase it is in, how many steps have failed in a row, and the
 * tuning of the pass in flight. When a pass ends the driver deletes all of
 * it, which is what lets the object cease to exist between passes
 * (developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage,
 * "Remove a Durable Object's storage").
 *
 * ## What one alarm step costs
 *
 * On top of the scan step's own budget, a step reads one row of Durable
 * Object storage and writes one, and `setAlarm` is itself billed as a row
 * written (developers.cloudflare.com/durable-objects/platform/pricing). None
 * of those are *subrequests* - storage is local to the object - so the
 * 50-subrequest budget in `scan.ts` is untouched. The daily ceilings the
 * chained alarms live inside, on the free plan, are 100,000 Durable Object
 * requests (alarm invocations included), 13,000 GB-s of duration and 100,000
 * rows written. A full first pass over 5,000 tracks is about 840 alarms and
 * about 1,700 rows written; a pass over an unchanged library is about twenty.
 *
 * ## Failure
 *
 * The platform retries a throwing `alarm()` six times and then stops
 * (developers.cloudflare.com/durable-objects/api/alarms, "alarm"), which is
 * not a safety net a pass measured in hundreds of steps can rely on - and the
 * docs say as much: catch the exception and schedule the next alarm yourself.
 * So a step that throws is caught, logged, and retried by an alarm scheduled
 * with exponential backoff from two seconds to a minute. After
 * `maxFailures` consecutive failures the driver stops and clears its state,
 * leaving the next cron poke to start a fresh pass; a scan that cannot make
 * progress should be quiet until something changes, not spin.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  DEFAULT_PLAYLIST_IMPORT_LIMITS,
  importPlaylists,
  type PlaylistImportLimits,
} from "../playlists/import";
import { DEFAULT_SCAN_LIMITS, runScan, type ScanLimits } from "./scan";

/** The one instance: a library has one scan, so it has one driver. */
export const SCAN_DRIVER_INSTANCE = "library";

/** The single storage key the driver keeps, so a step reads one row. */
const STATE_KEY = "driver";

/** How long after a finished step the next one starts. */
const STEP_DELAY_MS = 1_000;

/** How long after the first failed step it is tried again. */
const FIRST_RETRY_DELAY_MS = 2_000;

/** The ceiling the retry delay doubles up to. */
const MAX_RETRY_DELAY_MS = 60_000;

/** How many steps may fail in a row before the pass is abandoned. */
const MAX_FAILURES = 10;

/**
 * What a caller may vary about a pass.
 *
 * Production passes every one of these at its default; the tests use them to
 * make a pass take several steps without touching `DEFAULT_SCAN_LIMITS`, and
 * to move the delays out of the window a test runs in.
 */
export interface ScanDriverTuning {
  readonly stepDelayMs?: number;
  readonly firstRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly maxFailures?: number;
  readonly scanLimits?: Partial<ScanLimits>;
  readonly playlistLimits?: Partial<PlaylistImportLimits>;
}

/** The same, with every question answered, as the state carries it. */
interface Tuning {
  readonly stepDelayMs: number;
  readonly firstRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly maxFailures: number;
  readonly scanLimits: ScanLimits;
  readonly playlistLimits: PlaylistImportLimits;
}

/** Which half of a pass the next step belongs to. */
type Phase = "scan" | "playlists";

/** What a step leaves for the one after it: a phase, or the end of the pass. */
type Next = Phase | "done";

/** The driver's bookkeeping, as one stored row. */
interface DriverState {
  /** The phase the next step runs. */
  readonly phase: Phase;
  /** The instant the pass was poked at; every step of it is stamped with it. */
  readonly startedAt: number;
  /**
   * When the alarm this state belongs to was scheduled. It is how a poke
   * that arrives *during* a step can tell that the pass is alive, which
   * `getAlarm()` alone cannot: see `livelyFor` and `start`.
   */
  readonly armedAt: number;
  /** How many steps have failed in a row without one succeeding. */
  readonly failures: number;
  readonly tuning: Tuning;
}

/**
 * How long a state stays believable after its alarm was scheduled, with no
 * alarm in sight.
 *
 * The window has to cover the whole life of one alarm: the delay it was
 * scheduled with, and then the step itself, which the platform allows to run
 * for **15 minutes** (developers.cloudflare.com/workers/platform/limits,
 * "Duration", Durable Object Alarm). Anything older than that is a state
 * whose alarm never arrived, which is the one thing that would wedge the
 * driver for ever, so a poke is allowed to take it over.
 */
function livelyFor(tuning: Tuning): number {
  return tuning.maxRetryDelayMs + 15 * 60_000 + 60_000;
}

/** What a poke did. */
export type PokeOutcome =
  /** There was no pass in flight, and now there is. */
  | "started"
  /** A pass was already in flight, and it was left alone. */
  | "running";

export class ScanDriver extends DurableObject<Env> {
  /**
   * Starts a pass, unless one is already running.
   *
   * The cron entry calls this and nothing else: a cron invocation has **10 ms
   * of CPU** (developers.cloudflare.com/workers/platform/limits, "CPU time"),
   * which is no place to parse a tag, so the poke only arms the first alarm
   * and returns. Every step then runs in an alarm invocation, where the
   * Durable Objects limits table allows 30 seconds of CPU per request with no
   * plan split (confirmed in production by #30).
   *
   * `pokedAt` is the instant the whole pass is stamped with - the cron's
   * scheduled time in production - so the rows a pass writes carry the time
   * the pass began rather than the wall clock of whichever step wrote them.
   *
   * A poke while a pass is in flight is a no-op, which is what makes the cron
   * schedule harmless: it only decides how often a pass *starts*.
   *
   * Recognising that pass takes both of the questions below. A scheduled
   * alarm is the obvious sign, but it is not there while the alarm handler
   * is running: `getAlarm()` "returns null if called while an alarm is
   * already running, unless `setAlarm` has also been called since the alarm
   * handler started" (developers.cloudflare.com/durable-objects/api/alarms,
   * "getAlarm"). And a step is not atomic - input gates "only protect during
   * storage operations", so a poke *can* be delivered while `runScan` is
   * waiting on R2 or D1
   * (developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects,
   * "Avoid race conditions with non-storage I/O"). Without the second
   * question, a cron poke landing in the middle of a step - which is most of
   * a step's wall-clock time - would rewind the pass's stamp, phase and
   * failure count, and arm a second alarm beside the one the step is about
   * to arm.
   *
   * So a state is also taken as live while it is younger than `livelyFor`.
   * A state older than that whose alarm never arrived is the one thing that
   * would wedge the driver for ever, and a poke takes it over.
   */
  async start(pokedAt: number = Date.now(), tuning: ScanDriverTuning = {}): Promise<PokeOutcome> {
    const running = await this.read();
    if (running !== null && (await this.alive(running))) {
      return "running";
    }

    const settings = resolved(tuning);
    await this.arm(
      { phase: "scan", startedAt: pokedAt, armedAt: 0, failures: 0, tuning: settings },
      settings.stepDelayMs,
    );

    return "started";
  }

  /**
   * One step of the pass, and the alarm that carries on from it.
   *
   * The handler returns without rescheduling in exactly two cases: the pass
   * finished, or it failed too many times. Both clear the state, so the next
   * cron poke starts a fresh pass rather than resuming a dead one - and the
   * scan itself resumes from the cursor in D1 either way, so nothing is lost
   * but the attempt.
   *
   * `alarmInfo` should never say this is a platform retry, because every
   * failure inside a step is caught here and rescheduled by the driver
   * itself. If one ever arrives, something threw outside that `try` - the
   * storage write or `setAlarm` - and it is worth saying so in the log; the
   * attempt is still counted as an attempt, because it is one.
   */
  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    if (alarmInfo?.isRetry) {
      console.error(
        `scan driver: the platform retried this alarm (attempt ${alarmInfo.retryCount}); ` +
          "a step failed outside the handler's own error path",
      );
    }

    const state = await this.read();
    if (state === null) {
      // An alarm that outlived its pass: the driver has already stopped.
      return;
    }

    try {
      const next = await this.step(state);
      if (next === "done") {
        await this.stop();

        return;
      }

      await this.arm({ ...state, phase: next, failures: 0 }, state.tuning.stepDelayMs);
    } catch (error) {
      await this.retry(state, error);
    }
  }

  /** Runs the phase's step and says which phase the next one belongs to. */
  private async step(state: DriverState): Promise<Next> {
    const now = new Date(state.startedAt);

    if (state.phase === "scan") {
      const run = await runScan(this.env, now, state.tuning.scanLimits);
      console.log(
        run.completed
          ? `scan: pass complete, ${JSON.stringify(run.totals)}`
          : `scan: step complete, ${JSON.stringify(run.counts)}`,
      );

      // The import can only resolve an `.m3u` entry to a Track the scan has
      // already indexed (#17), so it is the second half of a pass, not a
      // parallel one.
      return run.completed ? "playlists" : "scan";
    }

    const imported = await importPlaylists(this.env, now, state.tuning.playlistLimits);
    console.log(
      imported.completed
        ? `playlists: pass complete, ${JSON.stringify(imported.totals)}`
        : `playlists: step complete, ${JSON.stringify(imported.counts)}`,
    );

    return imported.completed ? "done" : "playlists";
  }

  /** Logs a failed step and schedules the retry, or gives the pass up. */
  private async retry(state: DriverState, error: unknown): Promise<void> {
    const failures = state.failures + 1;
    console.error(
      `scan driver: the ${state.phase} step failed (${failures} in a row); ` +
        "the pass resumes from its cursor",
      error,
    );

    if (failures >= state.tuning.maxFailures) {
      console.error(
        `scan driver: giving up after ${failures} failed steps; ` +
          "the next cron poke starts a new pass",
      );
      await this.stop();

      return;
    }

    const delay = Math.min(
      state.tuning.firstRetryDelayMs * 2 ** (failures - 1),
      state.tuning.maxRetryDelayMs,
    );

    await this.arm({ ...state, failures }, delay);
  }

  /**
   * Writes the state the next alarm reads, then schedules that alarm.
   *
   * The state is stamped with the instant it was armed at, which costs
   * nothing - it rides in the row the step writes anyway - and is what a
   * poke arriving mid-step reads to see that the pass is alive.
   */
  private async arm(state: DriverState, delayMs: number): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.put(STATE_KEY, { ...state, armedAt: now });
    await this.ctx.storage.setAlarm(now + delayMs);
  }

  /** Whether this state belongs to a pass that is still going. */
  private async alive(state: DriverState): Promise<boolean> {
    if ((await this.ctx.storage.getAlarm()) !== null) {
      return true;
    }

    return Date.now() - state.armedAt < livelyFor(state.tuning);
  }

  /**
   * Ends the pass. Emptying the storage is what lets the object cease to
   * exist until the next poke, and deleting the specific key would not: the
   * docs are explicit that only `deleteAll()` clears everything a Durable
   * Object is billed for.
   */
  private async stop(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * The pass in flight, or null when there is none.
   *
   * A row this object cannot make sense of - written by an older version of
   * this class, or half written - reads as no pass, because a pass that
   * starts again is always correct and one resumed from a state nobody
   * understands is not.
   */
  private async read(): Promise<DriverState | null> {
    return restored(await this.ctx.storage.get(STATE_KEY));
  }
}

/* ------------------------------------------------------- the state -- */

/**
 * The tuning with every question answered.
 *
 * Every number is checked rather than taken as given, because this is also
 * the path a stored row comes back through, and a row written by an older
 * version of this class - or half written - could otherwise put a `NaN`
 * into `setAlarm` or a zero into a scan limit. Anything that is not a
 * positive, finite number is the default.
 */
function resolved(tuning: ScanDriverTuning): Tuning {
  const scan = tuning.scanLimits ?? {};
  const playlists = tuning.playlistLimits ?? {};

  return {
    stepDelayMs: positive(tuning.stepDelayMs, STEP_DELAY_MS),
    firstRetryDelayMs: positive(tuning.firstRetryDelayMs, FIRST_RETRY_DELAY_MS),
    maxRetryDelayMs: positive(tuning.maxRetryDelayMs, MAX_RETRY_DELAY_MS),
    maxFailures: positive(tuning.maxFailures, MAX_FAILURES),
    scanLimits: {
      pageSize: positive(scan.pageSize, DEFAULT_SCAN_LIMITS.pageSize),
      pagesPerRun: positive(scan.pagesPerRun, DEFAULT_SCAN_LIMITS.pagesPerRun),
      extractionsPerRun: positive(scan.extractionsPerRun, DEFAULT_SCAN_LIMITS.extractionsPerRun),
      deletionsPerPage: positive(scan.deletionsPerPage, DEFAULT_SCAN_LIMITS.deletionsPerPage),
    },
    playlistLimits: {
      pageSize: positive(playlists.pageSize, DEFAULT_PLAYLIST_IMPORT_LIMITS.pageSize),
      importsPerRun: positive(
        playlists.importsPerRun,
        DEFAULT_PLAYLIST_IMPORT_LIMITS.importsPerRun,
      ),
      objectsPerRun: positive(
        playlists.objectsPerRun,
        DEFAULT_PLAYLIST_IMPORT_LIMITS.objectsPerRun,
      ),
    },
  };
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function restored(stored: unknown): DriverState | null {
  if (typeof stored !== "object" || stored === null) {
    return null;
  }

  const state = stored as Partial<Record<keyof DriverState, unknown>>;
  const phase = state.phase;
  const startedAt = state.startedAt;
  if ((phase !== "scan" && phase !== "playlists") || typeof startedAt !== "number") {
    return null;
  }

  const tuning =
    typeof state.tuning === "object" && state.tuning !== null
      ? (state.tuning as ScanDriverTuning)
      : {};

  return {
    phase,
    startedAt,
    armedAt:
      typeof state.armedAt === "number" && Number.isFinite(state.armedAt) ? state.armedAt : 0,
    failures:
      typeof state.failures === "number" && state.failures > 0 ? Math.floor(state.failures) : 0,
    tuning: resolved(tuning),
  };
}
