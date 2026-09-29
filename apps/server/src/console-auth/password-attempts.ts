import { newRandomId, rateLimit } from "@stratosonic/db";
import { and, eq, gt, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db";

/**
 * A limit on wrong current passwords at `POST /api/account/password`.
 *
 * The route is behind a session, so whoever guesses there already holds one,
 * a stolen cookie say, and is after the password itself, which Subsonic
 * clients take as well. Better Auth's limiter covers only its own routes and
 * keys by address, so this counts the failed attempts per user, in its
 * `rate_limit` table under keys of their own (`account-password:<user id>`),
 * the same way its limiter counts: a window runs from the last counted
 * attempt, and a later attempt past it starts the count again at one.
 *
 * Only failures are written. A successful change reads the count, in the same
 * statement as the stored password, and writes nothing here; a refusal over
 * the limit writes nothing either, so a caller who keeps trying is not
 * buying a write a try. Rows are pruned by the cron with Better Auth's
 * (console-auth/prune.ts): `last_request` is epoch milliseconds, as there, and
 * the window is no longer than the longest one the prune allows for.
 */

/** How long the failures are counted after the last one. */
export const PASSWORD_ATTEMPT_WINDOW_MS = 60_000;

/** How many wrong current passwords a user gets within the window. */
export const MAX_FAILED_PASSWORD_ATTEMPTS = 5;

/** The prefix of the `rate_limit` keys this limit counts under. */
export const PASSWORD_ATTEMPT_KEY_PREFIX = "account-password:";

function attemptKey(userId: string): string {
  return `${PASSWORD_ATTEMPT_KEY_PREFIX}${userId}`;
}

/**
 * The user's failures still inside the window at `now`, as a scalar subquery
 * for the read that fetches the stored password: 0 when there are none.
 */
export function recentFailures(db: Database, userId: string, now: number): SQL<number> {
  const counted = db
    .select({ count: rateLimit.count })
    .from(rateLimit)
    .where(
      and(
        eq(rateLimit.key, attemptKey(userId)),
        gt(rateLimit.lastRequest, now - PASSWORD_ATTEMPT_WINDOW_MS),
      ),
    );

  return sql<number>`coalesce((${counted}), 0)`;
}

/** Whether a count from `recentFailures` has used the attempts up. */
export function tooManyFailures(failures: number): boolean {
  return failures >= MAX_FAILED_PASSWORD_ATTEMPTS;
}

/**
 * Counts a wrong current password: the first in a window creates or resets
 * the row at one, a later one adds one. One statement, one row.
 */
export async function recordFailedAttempt(
  db: Database,
  userId: string,
  now: number,
): Promise<void> {
  await db
    .insert(rateLimit)
    .values({ id: newRandomId(), key: attemptKey(userId), count: 1, lastRequest: now })
    .onConflictDoUpdate({
      target: rateLimit.key,
      set: {
        count: sql`case when ${rateLimit.lastRequest} > ${now - PASSWORD_ATTEMPT_WINDOW_MS} then ${rateLimit.count} + 1 else 1 end`,
        lastRequest: now,
      },
    });
}
