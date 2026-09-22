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

/** One item's play, at the instant it was played. */
export interface Play {
  readonly item: AnnotatedItem;
  readonly playDate: Date;
  /**
   * How many plays this row stands for; one unless the caller collapsed
   * several into it, as a submission of an album's tracks collapses into a
   * single play row for the album. `playDate` is then the latest of them.
   */
  readonly count?: number;
}

/**
 * Records the caller's plays: each increments the item's play count and moves
 * its last-played instant forward, leaving its star and rating alone. A play
 * the caller has never annotated starts the count at 1. Written in one D1
 * batch; the same item named twice in one call counts twice, as each
 * `scrobble` submission is a play — and a played track's album is one such
 * item, so `frequent` and `recent` album lists reflect the tracks played
 * from it.
 *
 * "Forward" is the whole of it: a client flushing an offline backlog sends
 * plays out of order, and an older `time` arriving after a newer one must not
 * drag `played` back into the past — it would unsort "recently played" and
 * make the newer play look undone. Navidrome guards it the same way, with
 * `max(ifnull(play_date, ''), ?)` in its annotation upsert.
 */
export async function recordPlays(
  db: Database,
  userId: string,
  plays: readonly Play[],
): Promise<void> {
  const statements = plays.map((play) => {
    const count = play.count ?? 1;

    return db
      .insert(annotation)
      .values({
        userId,
        itemId: play.item.id,
        itemType: play.item.type,
        playCount: count,
        playDate: play.playDate,
      })
      .onConflictDoUpdate({
        target: [annotation.userId, annotation.itemId, annotation.itemType],
        set: {
          playCount: sql`${annotation.playCount} + ${count}`,
          // `play_date` is stored as epoch milliseconds, so the incoming
          // instant is bound as a number and the two compare on one scale;
          // a row that has never been played counts as 0, the earliest.
          playDate: sql`max(ifnull(${annotation.playDate}, 0), ${play.playDate.getTime()})`,
        },
      });
  });

  const [first, ...rest] = statements;
  if (first === undefined) {
    return;
  }

  await db.batch([first, ...rest]);
}

/** The album and artist a track is attributed to. */
export interface TrackParents {
  readonly albumId: string;
  readonly artistId: string;
}

/**
 * The album and artist each of these tracks belongs to, by track id.
 *
 * A play counts for the track's album *and* its artist (Navidrome's
 * `PlayTracker.incPlay` increments the media file, the album and the
 * artist(s)), and a track carries a single `artist_id` — its album artist — so
 * one query answers both parents at once. Reading the artist here rather than
 * in a second lookup keeps the submission path's D1 cost unchanged.
 */
export async function findTrackParents(
  db: Database,
  trackIds: readonly string[],
): Promise<Map<string, TrackParents>> {
  // One parameter is bound per id, so the ids are taken
  // `KEYS_PER_STATEMENT` at a time, as the existence check above takes them:
  // a `scrobble` flushing an offline backlog of more than a hundred tracks
  // would otherwise throw `too many SQL variables` against D1 while passing
  // every test, because Miniflare is SQLite and allows 999. The chunks are
  // asked together, as that check asks its statements together.
  const lookups = [...chunked(trackIds)].map((chunk) =>
    db
      .select({ id: track.id, albumId: track.albumId, artistId: track.artistId })
      .from(track)
      .where(inArray(track.id, chunk)),
  );

  return new Map(
    (await Promise.all(lookups))
      .flat()
      .map((row) => [row.id, { albumId: row.albumId, artistId: row.artistId }] as const),
  );
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
      // Keep the original instant when the row is already starred and carries
      // one; otherwise stamp it now. A row starred without an instant is
      // reachable - a migrated row, or one this server left starred before -
      // and testing the flag alone would keep its null forever, hiding the
      // item from `getStarred2`, which orders by the instant. `starred_at` is
      // stored as epoch milliseconds, so the fallback is bound as a number,
      // not a Date.
      set: {
        starred: true,
        starredAt: sql`case when ${annotation.starred} and ${annotation.starredAt} is not null then ${annotation.starredAt} else ${now.getTime()} end`,
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
