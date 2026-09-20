import { database } from "../db";
import type { Env } from "../env";
import { updateLastAccessAt } from "../users/repository";

/**
 * Remembering when a user was last seen, cheaply.
 *
 * Writing on every request would spend the D1 free tier's daily write budget on
 * a timestamp nobody reads that often — and past that budget D1 fails hard, so
 * this would take the whole server down. Navidrome has the same shape of
 * problem and answers it with a per-user rate limiter in front of the update
 * (`UpdateLastAccessMiddleware`, server/middlewares.go, at
 * `consts.UpdateLastAccessFrequency`); this is that limiter.
 */

/** Navidrome's `consts.UpdateLastAccessFrequency`. */
const UPDATE_INTERVAL_MS = 60_000;

/**
 * When each user was last written, per isolate — as in Navidrome, where the
 * limiter lives in the process rather than in the database. An isolate starting
 * fresh costs at most one extra write per user.
 */
const lastWrittenAt = new Map<string, number>();

/**
 * Records that a user is active, at most once per interval per user.
 *
 * A failed write is logged and swallowed: the request itself succeeded, and
 * telling the client otherwise would turn a bookkeeping problem into an outage.
 */
export async function recordLastAccess(env: Env, userId: string): Promise<void> {
  const now = Date.now();
  const previous = lastWrittenAt.get(userId);

  if (previous !== undefined && now - previous < UPDATE_INTERVAL_MS) {
    return;
  }

  // Claimed before the write, so a burst of concurrent requests produces one
  // write rather than one per request.
  lastWrittenAt.set(userId, now);

  try {
    await updateLastAccessAt(database(env), userId, new Date(now));
  } catch (error) {
    console.error("could not update the user's last access time", error);
  }
}
