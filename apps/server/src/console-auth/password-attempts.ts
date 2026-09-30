import { newRandomId, rateLimit } from "@stratosonic/db";
import { lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db";

/**
 * A limit on attempts at `POST /api/account/password`.
 *
 * The route is behind a session, so whoever guesses there already holds one,
 * a stolen cookie say, and is after the password itself, which outlives any
 * session. Better Auth's limiter covers only its own routes and keys by
 * address, so this counts attempts in its `rate_limit` table under keys of
 * its own.
 *
 * The key is the session, `account-password:<session id>`, not the user:
 * a thief guessing with a stolen session must not be able to lock the victim
 * out of the one thing that revokes it, changing the password. Minting more
 * sessions to guess from needs the password, so a stolen session is worth
 * `MAX_PASSWORD_ATTEMPTS` guesses a window and no more.
 *
 * Every attempt is counted, before the password is checked, by a single
 * upsert that D1 runs atomically, so a burst of parallel requests cannot all
 * read a count under the limit: it counts the same way Better Auth's limiter
 * does (a window runs from the last counted attempt, and an attempt past it
 * starts the count again at one) and answers the new count, or nothing when
 * the limit is already reached, in which case it writes nothing either. A
 * successful change therefore writes its counter too, one row.
 *
 * Rows are pruned by the cron with Better Auth's (console-auth/prune.ts):
 * `last_request` is epoch milliseconds, as there, and the window is no longer
 * than the longest one the prune allows for.
 */

/** How long attempts are counted after the last one. */
export const PASSWORD_ATTEMPT_WINDOW_MS = 60_000;

/** How many attempts one session gets within the window. */
export const MAX_PASSWORD_ATTEMPTS = 5;

/** The prefix of the `rate_limit` keys this limit counts under. */
export const PASSWORD_ATTEMPT_KEY_PREFIX = "account-password:";

function attemptKey(sessionId: string): string {
  return `${PASSWORD_ATTEMPT_KEY_PREFIX}${sessionId}`;
}

/**
 * Counts an attempt by `sessionId` at `now`, as one statement for the
 * route's batch. It answers one row, the new count, when the attempt may go
 * ahead, and no row when the session has used its attempts up.
 */
export function countPasswordAttempt(db: Database, sessionId: string, now: number) {
  const windowStart = now - PASSWORD_ATTEMPT_WINDOW_MS;

  return db
    .insert(rateLimit)
    .values({ id: newRandomId(), key: attemptKey(sessionId), count: 1, lastRequest: now })
    .onConflictDoUpdate({
      target: rateLimit.key,
      set: {
        count: sql`case when ${rateLimit.lastRequest} > ${windowStart} then ${rateLimit.count} + 1 else 1 end`,
        lastRequest: now,
      },
      // Past the limit inside the window the row is left as it is, and the
      // upsert answers no row.
      setWhere: or(
        lte(rateLimit.lastRequest, windowStart),
        lt(rateLimit.count, MAX_PASSWORD_ATTEMPTS),
      ),
    })
    .returning({ count: rateLimit.count });
}
