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
 *
 * Both reads keep to the caller's `LibraryScope` (library/scope.ts), at
 * every step: an id in a library the caller cannot see names nothing, as
 * Navidrome's `GetEntityByID` finds nothing through its library filter, and
 * the artist an id leads to must have an album in scope, whose cover is
 * then one of those albums'.
 */

import { album, artist, type EntityId } from "@stratosonic/db";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db";
import { coverAlbumOf } from "./repository";
import { artistInScope, type LibraryScope, libraryFilter } from "./scope";

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
export async function findArtistFor(
  db: Database,
  entity: EntityId,
  scope: LibraryScope,
): Promise<InfoArtist | null> {
  const artistId = artistIdOf(entity, scope);
  if (artistId === null) {
    return null;
  }

  const rows = await db
    .select({ id: artist.id, coverAlbumId: coverAlbumOf(scope) })
    .from(artist)
    .where(and(eq(artist.id, artistId), artistInScope(scope)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The artist id an entity leads to, as a value or as a scalar subquery that
 * finds nothing for an album or a track out of scope.
 */
function artistIdOf(entity: EntityId, scope: LibraryScope): string | SQL | null {
  switch (entity.type) {
    case "artist":
      return entity.id;
    case "album":
      return sql`(select album.artist_id from album where album.id = ${entity.id}${inScope(scope, "album")})`;
    case "track":
      return sql`(select track.artist_id from track where track.id = ${entity.id}${inScope(scope, "track")})`;
    default:
      return null;
  }
}

/** ` and <table>.library_id in (...)` inside a subquery, or nothing on the fast path. */
function inScope(scope: LibraryScope, table: "album" | "track"): SQL {
  const filter = libraryFilter(scope, sql.raw(`${table}.library_id`));

  return filter === undefined ? sql`` : sql` and ${filter}`;
}

/**
 * The album an `al-` or `tr-` id stands for, or null when it names nothing or
 * names another kind — Navidrome's `getAlbum` follows a song to its album and
 * answers everything else, an artist included, with `ErrNotFound`.
 */
export async function findAlbumFor(
  db: Database,
  entity: EntityId,
  scope: LibraryScope,
): Promise<InfoAlbum | null> {
  const albumId = albumIdOf(entity, scope);
  if (albumId === null) {
    return null;
  }

  const rows = await db
    .select({ id: album.id, coverKey: album.coverKey })
    .from(album)
    .where(and(eq(album.id, albumId), libraryFilter(scope, album.libraryId)))
    .limit(1);

  return rows[0] ?? null;
}

/** The album id an entity leads to, as a value or as a scalar subquery. */
function albumIdOf(entity: EntityId, scope: LibraryScope): string | SQL | null {
  switch (entity.type) {
    case "album":
      return entity.id;
    case "track":
      return sql`(select track.album_id from track where track.id = ${entity.id}${inScope(scope, "track")})`;
    default:
      return null;
  }
}
