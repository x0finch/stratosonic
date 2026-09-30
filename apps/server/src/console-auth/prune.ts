import { consoleSession, consoleVerification, rateLimit } from "@stratosonic/db";
import { inArray, lt } from "drizzle-orm";
import type { Database } from "../db";

/**
 * Deletes the console's expired auth rows, from the cron (#93).
 *
 * Better Auth deletes them only on the way past. A session row outlives its
 * `expires_at` until its own cookie comes back to a session check, which may
 * be never. The rate limiter (1.7.6) does sweep, with an unbounded delete of
 * every row older than the longest window it has seen, but only when some
 * key's window resets, that is when an address comes back to a path after
 * its window is over; a caller rotating through fresh addresses never comes
 * back, so it never triggers the sweep and leaves a row behind for each
 * address. And `verification`, though no flow the console serves writes it,
 * keeps whatever expired rows it has. Hence this bounded prune on the cron.
 *
 * A row is deleted only once Better Auth would treat it as absent anyway: a
 * session past `expires_at` is refused and deleted by the next check that
 * reads it, and a rate-limit row whose window is over is reset to a count of
 * one by the next attempt, exactly as a missing row is created with one. The
 * prune's cut for `rate_limit`, the longest window plus an hour, is looser
 * than the limiter's own 60 seconds, so it never deletes a row the limiter
 * still counts. So the prune changes what D1 holds, never what a client sees.
 *
 * Budget: one D1 batch of three statements a cron run, whether or not
 * anything expired, and the cron runs 96 times a day (wrangler.jsonc). Each
 * delete is bounded to `PRUNE_LIMIT` rows through a subquery on the primary
 * key, so a backlog, however it grew, is worked off over several runs rather
 * than in one long write; the Worker's own CPU is a few statements' worth
 * either way, since the rows never leave D1.
 *
 * Rows written are the rows deleted, as D1's own `rows_written` counts them,
 * and zero on a run that finds nothing expired (test/console-auth-prune.test.ts
 * measures both). Only `rate_limit` can be grown by a stranger, and every row
 * of it cost a write to create, so the prune at most doubles what a flood of
 * addresses already cost: 500 × 96 = 48,000 rows a day at the very worst,
 * against the Free plan's 100,000, and a handful on an ordinary day.
 *
 * Neither `expires_at` nor `last_request` is indexed (an index on
 * `last_request` would cost a write on every sign-in attempt), so a statement
 * that finds fewer than `PRUNE_LIMIT` expired rows reads its whole table:
 * rows read are about 96 × (the three tables' sizes combined) a day, which
 * the prune itself keeps small. A backlog of about 50,000 rows would bring
 * that near the Free plan's 5,000,000 rows read a day, but a flood big enough
 * to build one runs into the 100,000 rows written a day first.
 */

/** The most rows one statement deletes in one cron run. */
export const PRUNE_LIMIT = 500;

/**
 * The longest window of any rate-limit rule Better Auth applies here: the
 * console's own `/sign-in/*` rule (console-auth/auth.ts) and Better Auth's
 * built-in rules both top out at 60 seconds. `last_request` is epoch
 * milliseconds (Better Auth compares it with `Date.now()`).
 */
export const LONGEST_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * How long a rate-limit row is kept after its last request: the longest
 * window plus an hour, a margin that keeps the prune safely clear of a window
 * a longer rule, or a clock that disagrees, might still be counting.
 */
export const RATE_LIMIT_RETENTION_MS = LONGEST_RATE_LIMIT_WINDOW_MS + 60 * 60_000;

/** How many rows a prune deleted, by table. */
export interface PrunedRows {
  readonly session: number;
  readonly rateLimit: number;
  readonly verification: number;
}

/**
 * Deletes up to `limit` expired rows from each of `session`, `rate_limit` and
 * `verification`, in one batch, as of `now` (epoch milliseconds).
 */
export async function pruneExpiredAuthRows(
  db: Database,
  now: number,
  limit: number = PRUNE_LIMIT,
): Promise<PrunedRows> {
  const at = new Date(now);

  const [sessions, rateLimits, verifications] = await db.batch([
    db
      .delete(consoleSession)
      .where(
        inArray(
          consoleSession.id,
          db
            .select({ id: consoleSession.id })
            .from(consoleSession)
            .where(lt(consoleSession.expiresAt, at))
            .limit(limit),
        ),
      ),
    db.delete(rateLimit).where(
      inArray(
        rateLimit.id,
        db
          .select({ id: rateLimit.id })
          .from(rateLimit)
          .where(lt(rateLimit.lastRequest, now - RATE_LIMIT_RETENTION_MS))
          .limit(limit),
      ),
    ),
    db
      .delete(consoleVerification)
      .where(
        inArray(
          consoleVerification.id,
          db
            .select({ id: consoleVerification.id })
            .from(consoleVerification)
            .where(lt(consoleVerification.expiresAt, at))
            .limit(limit),
        ),
      ),
  ]);

  return {
    session: sessions.meta.changes,
    rateLimit: rateLimits.meta.changes,
    verification: verifications.meta.changes,
  };
}

/** The prune's part of the cron's log line. */
export function describePrunedRows(pruned: PrunedRows): string {
  const total = pruned.session + pruned.rateLimit + pruned.verification;
  return `pruned ${total} expired console auth rows (session ${pruned.session}, rate_limit ${pruned.rateLimit}, verification ${pruned.verification})`;
}
