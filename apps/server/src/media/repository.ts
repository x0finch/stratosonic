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
 * one, in the order `getArtist` lists that artist's albums in.
 *
 * Artists have no image of their own in this library (#9), so one is borrowed,
 * and the rule has to be the same one the browsing endpoints sort by — a
 * client that is told the artist's `coverArt` is album X's must not be served
 * album Y's when it asks for it.
 *
 * That order is Navidrome's: `AlbumsByArtistID` sorts by `max_year`
 * (server/filter/filters.go), which `persistence/album_repository.go` maps to
 * year, then release date, then name. We hold no release date, so it is year,
 * then name, then the id as a tiebreaker so the answer never depends on the
 * order rows happen to come back in. A year we do not know sorts first, as
 * SQLite sorts NULL ascending, and matches what the browsing side does.
 */
export async function findArtistCoverAlbum(db: Database, artistId: string): Promise<Album | null> {
  const rows = await db
    .select()
    .from(album)
    .where(and(eq(album.artistId, artistId), isNotNull(album.coverKey)))
    .orderBy(asc(album.year), asc(album.name), asc(album.id))
    .limit(1);

  return rows[0] ?? null;
}
