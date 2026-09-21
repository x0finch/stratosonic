import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * A key/value store for server-wide flags, shaped like Navidrome's `property`
 * table: `id` primary key and `value` text defaulting to the empty string. The
 * first-run bootstrap flag lives here.
 */
export const property = sqliteTable("property", {
  id: text("id").primaryKey(),
  value: text("value").notNull().default(""),
});

export type Property = typeof property.$inferSelect;
export type NewProperty = typeof property.$inferInsert;

/**
 * An account that can log in, shaped like Navidrome's `user` table
 * (`model/user.go`).
 *
 * `password` holds the AES-GCM ciphertext of the plaintext password, not a
 * hash: Subsonic token auth needs the plaintext back to verify `md5(password +
 * salt)` (ADR-0003). `token_epoch` is Navidrome's per-user counter, bumped on a
 * password change to invalidate issued tokens; it is carried here so the column
 * exists when it is needed.
 *
 * Navidrome stores its timestamps as SQLite datetimes. Stratosonic starts with
 * an empty user table — no user rows are migrated — so timestamps are stored as
 * epoch milliseconds instead, which is what the rest of the protocol speaks.
 */
export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    userName: text("user_name").notNull(),
    name: text("name").notNull().default(""),
    email: text("email").notNull().default(""),
    password: text("password").notNull().default(""),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    tokenEpoch: integer("token_epoch").notNull().default(0),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    lastAccessAt: integer("last_access_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // Usernames are matched case-insensitively (Navidrome queries them
    // `COLLATE NOCASE`), so uniqueness has to ignore case as well: without
    // this, "Admin" and "admin" could both be created and a login would be
    // ambiguous.
    uniqueIndex("user_user_name_unique").on(sql`lower(${table.userName})`),
  ],
);

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

/**
 * The library tables, shaped like Navidrome's (`model/*.go`) so the cutover
 * stays a re-scan rather than a data mapping.
 *
 * Conventions shared by all of them:
 *
 * - Ids are the content-derived hashes of `ids.ts` (ADR-0002), stored bare;
 *   the `ar-`/`al-`/`tr-`/`pl-` prefixes exist only on the wire.
 * - Timestamps are epoch milliseconds, like the `user` table.
 * - Durations are seconds, kept as reals: a track's duration is fractional and
 *   an album's is the sum of its tracks', which integer seconds would drift.
 * - Artists, albums and tracks carry no foreign keys. D1 enforces them, and
 *   the scanner writes a track before the album row it belongs to is complete
 *   and deletes in the opposite order; Navidrome likewise keeps that integrity
 *   in the application. The two rows that belong to something rather than
 *   merely refer to it - a playlist's entries and a user's annotations - do
 *   have one, cascading: an orphan there is not a passing state during a scan
 *   but a row nothing can reach and `getStarred2` would still count.
 * - A column is nullable exactly when "absent" is a value the protocol has to
 *   render differently from zero (a missing year is omitted, not `0`).
 */

/** The album artist an album and its tracks are attributed to. */
export const artist = sqliteTable("artist", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Navidrome's `sort_artist_name`: empty when the tags do not supply one. */
  sortName: text("sort_name").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export type Artist = typeof artist.$inferSelect;
export type NewArtist = typeof artist.$inferInsert;

/**
 * A group of tracks sharing an album artist, album name and year.
 *
 * `songCount`, `duration` and `size` are stored rather than derived, as
 * Navidrome stores them: the scanner recomputes them from the album's tracks
 * whenever one of them changes, and the read endpoints then answer without an
 * aggregate. `coverKey` is the R2 key of the cover extracted from the first
 * track that carried one, or null when no track did — in which case `coverArt`
 * is omitted from every response about this album.
 */
export const album = sqliteTable(
  "album",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    artistId: text("artist_id").notNull(),
    albumArtist: text("album_artist").notNull(),
    year: integer("year"),
    genre: text("genre"),
    songCount: integer("song_count").notNull().default(0),
    duration: real("duration").notNull().default(0),
    size: integer("size").notNull().default(0),
    coverKey: text("cover_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // `getArtist` lists an artist's albums, and `getArtists` counts them.
    index("album_artist_id_idx").on(table.artistId),
  ],
);

export type Album = typeof album.$inferSelect;
export type NewAlbum = typeof album.$inferInsert;

/**
 * A single playable audio file, identified by its R2 key.
 *
 * The key is unique because it is what the track's id is derived from: two rows
 * with the same key would be the same track twice. `etag` together with `size`
 * is the scanner's change signal — R2 ETags of multipart uploads are not MD5s,
 * so neither alone is enough. `contentType` is not stored: it is derived from
 * `suffix` through the one suffix map that also decides what the scanner
 * indexes.
 */
export const track = sqliteTable(
  "track",
  {
    id: text("id").primaryKey(),
    r2Key: text("r2_key").notNull().unique(),
    title: text("title").notNull(),
    albumId: text("album_id").notNull(),
    artistId: text("artist_id").notNull(),
    /** The track's own artist, which may differ from the album artist. */
    artist: text("artist").notNull(),
    albumArtist: text("album_artist").notNull(),
    trackNumber: integer("track_number"),
    discNumber: integer("disc_number"),
    year: integer("year"),
    /** Seconds, derived from the file's headers — never by decoding it. */
    duration: real("duration").notNull().default(0),
    /** Kilobits per second, as Subsonic reports it. */
    bitRate: integer("bit_rate").notNull().default(0),
    size: integer("size").notNull().default(0),
    suffix: text("suffix").notNull(),
    genre: text("genre"),
    etag: text("etag").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // `getAlbum` lists an album's tracks; the artist index serves the deletion
    // sweep and folder browsing.
    index("track_album_id_idx").on(table.albumId),
    index("track_artist_id_idx").on(table.artistId),
  ],
);

export type Track = typeof track.$inferSelect;
export type NewTrack = typeof track.$inferInsert;

/**
 * A user-ordered list of tracks, imported from an `.m3u` object in R2.
 *
 * `r2Key` is the key of that `.m3u` and is what the playlist's id is derived
 * from, so re-importing an edited file updates the same row. `changedAt` is
 * Subsonic's `changed` attribute, which is why it is not called `updatedAt`.
 */
export const playlist = sqliteTable(
  "playlist",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    comment: text("comment").notNull().default(""),
    ownerId: text("owner_id").notNull(),
    public: integer("public", { mode: "boolean" }).notNull().default(true),
    songCount: integer("song_count").notNull().default(0),
    duration: real("duration").notNull().default(0),
    // Unique for the same reason a track's key is: the playlist's id is
    // derived from it, so two rows with the same key would be one playlist
    // twice.
    r2Key: text("r2_key").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    changedAt: integer("changed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("playlist_owner_id_idx").on(table.ownerId)],
);

export type Playlist = typeof playlist.$inferSelect;
export type NewPlaylist = typeof playlist.$inferInsert;

/**
 * One track's place in one playlist.
 *
 * The primary key is (playlist, position) rather than (playlist, track): a
 * playlist may list the same track twice, but not two tracks at the same
 * position. That key is also the index a playlist's tracks are read by, so no
 * separate index on `playlist_id` is needed.
 *
 * An entry exists only as part of its playlist, so deleting the playlist takes
 * its entries with it. The track it points at is a reference, not a parent:
 * the scanner deletes tracks in its sweep and tidies the entries itself.
 */
export const playlistTrack = sqliteTable(
  "playlist_track",
  {
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlist.id, { onDelete: "cascade" }),
    trackId: text("track_id").notNull(),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.playlistId, table.position] }),
    // The deletion sweep removes the entries of a track that left R2.
    index("playlist_track_track_id_idx").on(table.trackId),
  ],
);

export type PlaylistTrack = typeof playlistTrack.$inferSelect;
export type NewPlaylistTrack = typeof playlistTrack.$inferInsert;

/** What an annotation can be attached to, as Navidrome's `item_type` spells it. */
export const ANNOTATION_ITEM_TYPES = ["track", "album", "artist", "playlist"] as const;

export type AnnotationItemType = (typeof ANNOTATION_ITEM_TYPES)[number];

/**
 * A user's state for one item: starred, rated, played.
 *
 * Keyed by (user, item, item type) exactly as Navidrome's `annotation` table
 * is, because an album and a track can share neither a row nor, in principle,
 * an id. The rows belong to their user and go when the user does. The table
 * starts empty — no history is migrated — and Phase 1 only
 * reads it, so `getStarred2` has something to answer from.
 */
export const annotation = sqliteTable(
  "annotation",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    itemType: text("item_type", { enum: ANNOTATION_ITEM_TYPES }).notNull(),
    starred: integer("starred", { mode: "boolean" }).notNull().default(false),
    starredAt: integer("starred_at", { mode: "timestamp_ms" }),
    rating: integer("rating").notNull().default(0),
    playCount: integer("play_count").notNull().default(0),
    playDate: integer("play_date", { mode: "timestamp_ms" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.itemId, table.itemType] }),
    // `getStarred2` reads one user's starred items of one type.
    index("annotation_user_id_item_type_idx").on(table.userId, table.itemType),
    // The item type is closed: a row of an unknown type would be unreachable
    // through every endpoint and still counted by the ones that aggregate.
    check(
      "annotation_item_type_check",
      sql`${table.itemType} in ('track', 'album', 'artist', 'playlist')`,
    ),
  ],
);

export type Annotation = typeof annotation.$inferSelect;
export type NewAnnotation = typeof annotation.$inferInsert;

/**
 * Who a user is listening to right now, one row per user — as Navidrome keeps
 * one now-playing entry per user (`core/playback`/`ffmpeg` aside, its
 * `NowPlaying` map is keyed by user). `scrobble` with `submission=false`
 * writes it at the start of a track; `getNowPlaying` returns only the rows
 * whose `startedAt` is within a TTL window, and a stale one is left to be
 * overwritten in place by the next track rather than swept, so the free tier
 * runs no cleaner.
 */
export const nowPlaying = sqliteTable("now_playing", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  trackId: text("track_id").notNull(),
  /** The client's `c` parameter, shown in the now-playing feed. */
  playerName: text("player_name").notNull().default(""),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
});

export type NowPlaying = typeof nowPlaying.$inferSelect;
export type NewNowPlaying = typeof nowPlaying.$inferInsert;
