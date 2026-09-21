import { type Album, album, type EntityId, type Track, track } from "@stratosonic/db";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../db";

/**
 * The reads the media endpoints make: a track by its id, and the cover object
 * an id of any kind resolves to.
 */

/** The track a `tr-` id names, or null when no row has that id. */
export async function findTrackById(db: Database, id: string): Promise<Track | null> {
  const rows = await db.select().from(track).where(eq(track.id, id)).limit(1);

  return rows[0] ?? null;
}

/** The album an `al-` id names. */
export async function findAlbumById(db: Database, id: string): Promise<Album | null> {
  const rows = await db.select().from(album).where(eq(album.id, id)).limit(1);

  return rows[0] ?? null;
}

/**
 * The R2 key of the cover a client-facing id resolves to, or null when there
 * is none — an id naming nothing, a playlist, or an album whose tracks carried
 * no artwork.
 *
 * All three kinds of id end at an album's cover, because an album's cover is
 * the only artwork the library stores (#9): a track shows its album's, and an
 * artist shows one of its albums'.
 */
export async function findCoverKey(db: Database, entity: EntityId): Promise<string | null> {
  switch (entity.type) {
    case "album":
      return (await findAlbumById(db, entity.id))?.coverKey ?? null;

    case "track": {
      const found = await findTrackById(db, entity.id);

      return found === null ? null : ((await findAlbumById(db, found.albumId))?.coverKey ?? null);
    }

    case "artist":
      return (await findArtistCoverAlbum(db, entity.id))?.coverKey ?? null;

    default:
      return null;
  }
}

/**
 * The album whose cover stands for an artist: the first of its albums that has
 * one, in the order the artist's albums are listed in — by name, then by year,
 * so a client sees the same picture whichever endpoint it asks.
 *
 * Artists have no image of their own in this library (#9); this is the rule
 * that decides which of an artist's covers is borrowed.
 */
export async function findArtistCoverAlbum(db: Database, artistId: string): Promise<Album | null> {
  const rows = await db
    .select()
    .from(album)
    .where(and(eq(album.artistId, artistId), isNotNull(album.coverKey)))
    .orderBy(asc(album.name), asc(album.year))
    .limit(1);

  return rows[0] ?? null;
}
