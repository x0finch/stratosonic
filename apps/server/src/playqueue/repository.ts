/**
 * The `play_queue` table: the queue a listener carries between devices, one
 * row per user.
 *
 * `savePlayQueue` replaces that row wholesale — Navidrome's repository clears
 * the user's queue and stores the new one, so a save is never a merge — and a
 * save with no tracks leaves no row at all, which is how a client clears its
 * queue. `getPlayQueue` reads the row in one statement and resolves the
 * entries in a second pass, so the cost of a queue is its length divided by
 * what one `in (...)` may bind, not one query per entry.
 *
 * The ordered ids live in one text column as a JSON array. They are read and
 * written whole and never queried into, so a row per entry would buy nothing
 * and cost a statement per chunk on every save.
 */

import { playQueue } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import type { Database } from "../db";

/** A saved queue as the client sent it, with bare track ids. */
export interface SavedPlayQueue {
  /** The queue in order; ids that name no track are kept as they arrived. */
  readonly trackIds: readonly string[];
  /** The track the listener is on, or null when the client named none. */
  readonly current: string | null;
  /** Milliseconds into the current track. */
  readonly position: number;
  /** The client's `c` parameter. */
  readonly changedBy: string;
  readonly changedAt: Date;
}

/**
 * Replaces the caller's queue with this one, in one statement. The row is
 * upserted rather than deleted and inserted: there is at most one per user, so
 * "replace what is there" and "write a new one" are the same write.
 */
export async function savePlayQueue(
  db: Database,
  userId: string,
  queue: SavedPlayQueue,
): Promise<void> {
  const values = {
    trackIds: JSON.stringify([...queue.trackIds]),
    current: queue.current,
    position: queue.position,
    changedBy: queue.changedBy,
    changedAt: queue.changedAt,
  };

  await db
    .insert(playQueue)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: playQueue.userId, set: values });
}

/**
 * Forgets the caller's queue. A `savePlayQueue` naming no track means "I have
 * nothing queued", which Navidrome stores as no queue at all rather than as an
 * empty one, so the next `getPlayQueue` answers exactly as it does for a user
 * who has never saved.
 */
export async function clearPlayQueue(db: Database, userId: string): Promise<void> {
  await db.delete(playQueue).where(eq(playQueue.userId, userId));
}

/** The caller's queue, or null when they have none saved. */
export async function findPlayQueue(db: Database, userId: string): Promise<SavedPlayQueue | null> {
  const rows = await db.select().from(playQueue).where(eq(playQueue.userId, userId)).limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    trackIds: parseTrackIds(row.trackIds),
    current: row.current,
    position: row.position,
    changedBy: row.changedBy,
    changedAt: row.changedAt,
  };
}

/**
 * The ids stored in the column. Only this module writes it, so the value is a
 * JSON array of strings; anything else is a row no version of this code wrote,
 * and reading it as an empty queue loses that user's queue rather than
 * failing every `getPlayQueue` they make.
 */
function parseTrackIds(stored: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stored);

    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}
