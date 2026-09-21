/**
 * The write side of the `annotation` table: the caller's stars, ratings and
 * plays. The read side (decorating items with the caller's annotation) lives
 * in `library/annotations.ts`; this is where `star`, `unstar` and, later,
 * `setRating` and `scrobble` put the rows those reads pick up.
 *
 * A row belongs to a `(user, item, item type)`. Every write here is that
 * user's alone, so two accounts sharing a library keep separate stars and
 * ratings, and a write names the item type because an album and a track could
 * in principle share an id.
 */

import { album, annotation, artist, track } from "@stratosonic/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "../db";

/** The kinds of item a star or a rating can attach to. */
export type AnnotatedType = "track" | "album" | "artist";

/** An item a write names: its type, and its stored id. */
export interface AnnotatedItem {
  readonly type: AnnotatedType;
  readonly id: string;
}

/** The table each kind of item lives in, for the existence check. */
const ITEM_TABLES = { track, album, artist } as const;

/**
 * Which of these items name nothing in the library.
 *
 * `star` on an id that resolves to no track, album or artist is error 70, so
 * the items are checked before anything is written — one query per kind that
 * appears, never one per id. An id whose row is present is fine; the rest are
 * returned for the endpoint to refuse.
 */
export async function findMissingItems(
  db: Database,
  items: readonly AnnotatedItem[],
): Promise<AnnotatedItem[]> {
  const missing: AnnotatedItem[] = [];

  for (const type of ["track", "album", "artist"] as const) {
    const ofType = items.filter((item) => item.type === type);
    if (ofType.length === 0) {
      continue;
    }

    const idColumn = ITEM_TABLES[type].id;
    const rows = await db
      .select({ id: idColumn })
      .from(ITEM_TABLES[type])
      .where(
        inArray(
          idColumn,
          ofType.map((item) => item.id),
        ),
      );

    const present = new Set(rows.map((row) => row.id));
    for (const item of ofType) {
      if (!present.has(item.id)) {
        missing.push(item);
      }
    }
  }

  return missing;
}

/**
 * Stars or unstars the caller's items, in one D1 batch.
 *
 * Starring upserts the row: a new one records `starred_at` now, and an
 * already-starred one keeps the instant it was first starred, so starring
 * twice is idempotent — the order "most recently starred" that `getStarred2`
 * reads does not shuffle when a client re-sends a star it already has.
 * Unstarring clears the flag and the instant on whatever row exists and
 * inserts nothing: an item that was never annotated has nothing to unstar.
 */
export async function setStarred(
  db: Database,
  userId: string,
  items: readonly AnnotatedItem[],
  starred: boolean,
  now: Date,
): Promise<void> {
  const statements = items.map((item) =>
    starred ? starStatement(db, userId, item, now) : unstarStatement(db, userId, item),
  );

  const [first, ...rest] = statements;
  if (first === undefined) {
    return;
  }

  await db.batch([first, ...rest]);
}

/**
 * Sets the caller's rating for one item, leaving its star and play data
 * untouched. A rating of 0 is stored as 0, which the serializers omit — the
 * way a client clears a rating. The row is created if the caller has never
 * annotated the item before.
 */
export async function setRating(
  db: Database,
  userId: string,
  item: AnnotatedItem,
  rating: number,
): Promise<void> {
  await db
    .insert(annotation)
    .values({ userId, itemId: item.id, itemType: item.type, rating })
    .onConflictDoUpdate({
      target: [annotation.userId, annotation.itemId, annotation.itemType],
      set: { rating },
    });
}

function starStatement(
  db: Database,
  userId: string,
  item: AnnotatedItem,
  now: Date,
): BatchItem<"sqlite"> {
  return db
    .insert(annotation)
    .values({ userId, itemId: item.id, itemType: item.type, starred: true, starredAt: now })
    .onConflictDoUpdate({
      target: [annotation.userId, annotation.itemId, annotation.itemType],
      // Keep the original instant when the row is already starred; otherwise
      // stamp it now. `starred_at` is stored as epoch milliseconds, so the
      // fallback is bound as a number, not a Date.
      set: {
        starred: true,
        starredAt: sql`case when ${annotation.starred} then ${annotation.starredAt} else ${now.getTime()} end`,
      },
    });
}

function unstarStatement(db: Database, userId: string, item: AnnotatedItem): BatchItem<"sqlite"> {
  return db
    .update(annotation)
    .set({ starred: false, starredAt: null })
    .where(
      and(
        eq(annotation.userId, userId),
        eq(annotation.itemId, item.id),
        eq(annotation.itemType, item.type),
      ),
    );
}
