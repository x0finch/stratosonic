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
 *
 * **No statement binds more than D1 allows.** The existence check binds one
 * parameter per id, so it is chunked with the scan's `chunked` and
 * `KEYS_PER_STATEMENT` (`scanner/repository.ts`) - the budget belongs to the
 * platform rather than to the scan, and D1's ceiling of 100 bound parameters
 * per query would otherwise throw `too many SQL variables` in production for
 * a request naming more than a hundred ids, while passing every test, because
 * Miniflare is real SQLite, whose limit is 999.
 */

import { album, annotation, artist, playlist, track } from "@stratosonic/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "../db";
import { chunked } from "../scanner/repository";

/**
 * The kinds of item a star or a rating can attach to — every kind the
 * `annotation` table's `item_type` allows, playlists included, as Navidrome's
 * `setStar` stars a playlist like anything else.
 */
export const ANNOTATED_TYPES = ["track", "album", "artist", "playlist"] as const;

export type AnnotatedType = (typeof ANNOTATED_TYPES)[number];

/** An item a write names: its type, and its stored id. */
export interface AnnotatedItem {
  readonly type: AnnotatedType;
  readonly id: string;
}

/** The table each kind of item lives in, for the existence check. */
const ITEM_TABLES = { track, album, artist, playlist } as const;

/**
 * Which of these items name nothing in the library.
 *
 * `star` on an id that resolves to no row of its kind is error 70, so
 * the items are checked before anything is written — one query per kind that
 * appears, and per `KEYS_PER_STATEMENT` ids of that kind, never one per id.
 * The kinds are asked together, as the reads ask their statements together.
 * An id whose row is present is fine; the rest are returned for the endpoint
 * to refuse.
 */
export async function findMissingItems(
  db: Database,
  items: readonly AnnotatedItem[],
): Promise<AnnotatedItem[]> {
  const lookups: Promise<string[]>[] = [];

  for (const type of ANNOTATED_TYPES) {
    const ofType = items.filter((item) => item.type === type);
    if (ofType.length === 0) {
      continue;
    }

    for (const chunk of chunked(ofType)) {
      lookups.push(findPresentOfType(db, type, chunk));
    }
  }

  // One key per (kind, id), so an album and a track sharing an id stay apart.
  const present = new Set((await Promise.all(lookups)).flat());

  return items.filter((item) => !present.has(itemKey(item.type, item.id)));
}

/** The ids of this chunk that a row of this kind answers to, as keys. */
async function findPresentOfType(
  db: Database,
  type: AnnotatedType,
  chunk: readonly AnnotatedItem[],
): Promise<string[]> {
  const idColumn = ITEM_TABLES[type].id;
  const rows = await db
    .select({ id: idColumn })
    .from(ITEM_TABLES[type])
    .where(
      inArray(
        idColumn,
        chunk.map((item) => item.id),
      ),
    );

  return rows.map((row) => itemKey(type, row.id));
}

function itemKey(type: AnnotatedType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Stars or unstars the caller's items, in one D1 batch.
 *
 * Starring upserts the row: a new one records `starred_at` now, and an
 * already-starred one keeps the instant it was first starred, so starring
 * twice is idempotent — the order "most recently starred" that `getStarred2`
 * reads does not shuffle when a client re-sends a star it already has. That
 * is issue #40's requirement, not Navidrome's behaviour: Navidrome's
 * `SetStar` stamps `starred_at` with now on every star, re-sent or not.
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
