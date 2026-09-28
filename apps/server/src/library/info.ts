/**
 * The reads behind `getArtistInfo` and `getAlbumInfo`: which artist or album
 * an id stands for, and whether it has artwork. One statement each.
 *
 * Navidrome resolves the id through `model.GetEntityByID` and then follows it
 * to the entity the endpoint describes (`getArtist` and `getAlbum` in
 * core/external/provider.go): a song stands for its album, and a song or an
 * album stands for its artist. The follow-up is a subquery here rather than a
 * second round trip, and it still has to land on a row — an album whose
 * artist row is gone is "not found", as Navidrome's lookup of
 * `v.AlbumArtistID` finds nothing there either.
 *
 * The subqueries are written out, as `artistColumns`' are: they are small,
 * and a hand-written one cannot lose a table qualifier to Drizzle.
 */

import { album, artist, type EntityId } from "@stratosonic/db";
import { eq, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db";
import { artistColumns } from "./repository";

/** What the info endpoints need of an artist: whether it has a cover, and whose. */
export interface InfoArtist {
  readonly id: string;
  /** The album whose cover stands for the artist, or null when none has one. */
  readonly coverAlbumId: string | null;
}

/** What the info endpoints need of an album: its id and whether it has a cover. */
export interface InfoAlbum {
  readonly id: string;
  readonly coverKey: string | null;
}

/**
 * The artist an `ar-`, `al-` or `tr-` id stands for, or null when it names
 * nothing — or names a kind Navidrome's `getArtist` does not follow, which is
 * every other kind (`default: return auxArtist{}, model.ErrNotFound`).
 */
export async function findArtistFor(db: Database, entity: EntityId): Promise<InfoArtist | null> {
  const artistId = artistIdOf(entity);
  if (artistId === null) {
    return null;
  }

  const rows = await db
    .select({ id: artist.id, coverAlbumId: artistColumns.coverAlbumId })
    .from(artist)
    .where(eq(artist.id, artistId))
    .limit(1);

  return rows[0] ?? null;
}

/** The artist id an entity leads to, as a value or as a scalar subquery. */
function artistIdOf(entity: EntityId): string | SQL | null {
  switch (entity.type) {
    case "artist":
      return entity.id;
    case "album":
      return sql`(select album.artist_id from album where album.id = ${entity.id})`;
    case "track":
      return sql`(select track.artist_id from track where track.id = ${entity.id})`;
    default:
      return null;
  }
}

/**
 * The album an `al-` or `tr-` id stands for, or null when it names nothing or
 * names another kind — Navidrome's `getAlbum` follows a song to its album and
 * answers everything else, an artist included, with `ErrNotFound`.
 */
export async function findAlbumFor(db: Database, entity: EntityId): Promise<InfoAlbum | null> {
  const albumId = albumIdOf(entity);
  if (albumId === null) {
    return null;
  }

  const rows = await db
    .select({ id: album.id, coverKey: album.coverKey })
    .from(album)
    .where(eq(album.id, albumId))
    .limit(1);

  return rows[0] ?? null;
}

/** The album id an entity leads to, as a value or as a scalar subquery. */
function albumIdOf(entity: EntityId): string | SQL | null {
  switch (entity.type) {
    case "album":
      return entity.id;
    case "track":
      return sql`(select track.album_id from track where track.id = ${entity.id})`;
    default:
      return null;
  }
}
