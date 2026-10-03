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
 * A Subsonic user, an account a Subsonic client logs in with, shaped like
 * Navidrome's `user` table (`model/user.go`).
 *
 * The table is `subsonic_user`, not Navidrome's `user`, because the admin
 * console's own users take Better Auth's standard `user` table below (#99):
 * the two kinds of account are separate, and each keeps the name its own
 * reference implementation uses for it. Only the name differs from
 * Navidrome's; migration 0008 renamed the table and nothing else.
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
export const subsonicUser = sqliteTable(
  "subsonic_user",
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
    uniqueIndex("subsonic_user_user_name_unique").on(sql`lower(${table.userName})`),
  ],
);

export type SubsonicUser = typeof subsonicUser.$inferSelect;
export type NewSubsonicUser = typeof subsonicUser.$inferInsert;

/**
 * The admin console's own users, with their sessions and credentials (#99), in
 * Better Auth's core schema under its standard table names (v1.7: `user`,
 * `session`, `account`, `verification`), plus the table its database-backed
 * rate limiter keeps. Column names follow the snake_case of the tables above,
 * and timestamps are epoch milliseconds like theirs.
 *
 * A console user is not a Subsonic user. The console is for administration
 * only: a console user never signs in to Subsonic, and a Subsonic user never
 * signs in to the console, so nothing here refers to `subsonic_user`. Each
 * console user has one role, which grants a set of permissions (apps/server's
 * `console-auth/permissions.ts`); `owner` is the only role for now.
 *
 * Better Auth reads these rows and writes the sessions itself. Console users
 * and their passwords are written only by apps/server's
 * `console-auth/credentials.ts`, and a password is stored as a peppered
 * HMAC-SHA256 digest, not reversibly (ADR-0007).
 */
export const consoleUser = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    // Better Auth's required display name: the name as entered.
    name: text("name").notNull(),
    // The username plugin's `displayUsername`, the name as entered, which is
    // what the console shows and what `GET /api/me` answers.
    displayUsername: text("display_username").notNull(),
    // The username plugin's `username`, what a sign-in is looked up by. It is
    // derived and never written: SQLite's `lower()` folds ASCII letters only,
    // exactly as the plugin's `usernameNormalization` does
    // (console-auth/auth.ts), so a name is found in any ASCII case.
    username: text("username")
      .notNull()
      .generatedAlwaysAs(sql`lower("display_username")`, { mode: "virtual" }),
    // Better Auth's `email`, which its schema requires and keeps unique. A
    // console user has no address, so it gets a placeholder that no mail can
    // reach (RFC 2606 reserves `.invalid`). No route that uses it is enabled.
    email: text("email")
      .notNull()
      .generatedAlwaysAs(sql`lower("display_username") || '@console.invalid'`, {
        mode: "virtual",
      }),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    image: text("image"),
    // What the console user may do, as a role that apps/server's
    // `console-auth/permissions.ts` maps to permissions. There is no default,
    // so a row cannot be written without one, and no CHECK: SQLite can only
    // change one by rebuilding the table, and a role that registry does not
    // know grants nothing.
    role: text("role").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // One console user per folded name, which is also the index the username
    // plugin's `WHERE username = ?` is served from.
    uniqueIndex("user_username_unique").on(table.username),
    // Better Auth's own uniqueness rule for `email`.
    uniqueIndex("user_email_unique").on(table.email),
    // At most one owner, whatever writes a row: two setups racing, or any
    // later code, cannot make a second.
    uniqueIndex("user_one_owner").on(table.role).where(sql`role = 'owner'`),
  ],
);

export type ConsoleUser = typeof consoleUser.$inferSelect;

export const consoleSession = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => consoleUser.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const consoleAccount = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    // For the `credential` provider, Better Auth looks the account up by
    // `account_id = user_id`.
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => consoleUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    // `hmac-sha256$v1$<salt>$<digest>` (ADR-0007).
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    // At most one credential account per console user, so the password
    // writer's `WHERE user_id = ? AND provider_id = 'credential'` names one row.
    uniqueIndex("account_provider_account_unique").on(table.providerId, table.accountId),
  ],
);

/**
 * Unused by the console's flows (it holds email-verification and reset
 * tokens), but part of the core schema Better Auth checks its adapter against.
 */
export const consoleVerification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

/**
 * The sign-in rate limiter's counters: one row per client address and path.
 * `last_request` is epoch milliseconds, which Better Auth compares as a number.
 */
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});

/** How a library's bucket is reached: the Worker's binding, or the S3 API. */
export const LIBRARY_KINDS = ["r2-binding", "s3"] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/** A library is served while `active`; `removing` hides it until it is gone. */
export const LIBRARY_STATES = ["active", "removing"] as const;

export type LibraryState = (typeof LIBRARY_STATES)[number];

/**
 * A bucket this server serves as a library, Navidrome's `library` table
 * (`model/library.go`) with a storage URI as its `path` (ADR-0009).
 *
 * Library 1 is the bucket the Worker is bound to (`MUSIC`): migration 0009
 * seeds it as `Music Library`, `r2-binding://MUSIC`, and it can never be
 * removed. Any other is an R2 bucket reached through the S3 API, with
 * `endpoint`, `region`, `bucket` and its sealed token in `credentials`, all
 * null for library 1.
 *
 * - `id` is autoincrement, so an id is never reused: a folder id a client
 *   stored can never come to name another library.
 * - `name` is what `getMusicFolders` answers, unique ignoring case.
 * - `path` is unique, so one bucket cannot be connected twice.
 * - `writable` is what the last connection test's write probe found.
 * - `defaultNewUsers` gives the library to every new non-admin user, as
 *   Navidrome's `default_new_users` does.
 * - `state` is `removing` from the moment a removal is asked for until the
 *   scan has deleted the library's rows.
 * - `lastScanStartedAt` and `lastScanAt` are stamped as the scan enters and
 *   leaves the library, and `lastScanError` says why the last pass skipped it.
 *
 * No column carries a CHECK, as `user.role` carries none: SQLite can only
 * change one by rebuilding the table, and the code reads the closed sets.
 */
export const library = sqliteTable(
  "library",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    path: text("path").notNull().unique(),
    kind: text("kind", { enum: LIBRARY_KINDS }).notNull(),
    endpoint: text("endpoint"),
    region: text("region"),
    bucket: text("bucket"),
    credentials: text("credentials"),
    writable: integer("writable", { mode: "boolean" }).notNull().default(true),
    defaultNewUsers: integer("default_new_users", { mode: "boolean" }).notNull().default(false),
    state: text("state", { enum: LIBRARY_STATES }).notNull().default("active"),
    lastScanStartedAt: integer("last_scan_started_at", { mode: "timestamp_ms" }),
    lastScanAt: integer("last_scan_at", { mode: "timestamp_ms" }),
    lastScanError: text("last_scan_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // Clients show the name in their folder picker, so two that differ only
    // in case would be indistinguishable there.
    uniqueIndex("library_name_unique").on(sql`lower(${table.name})`),
  ],
);

export type Library = typeof library.$inferSelect;
export type NewLibrary = typeof library.$inferInsert;

/**
 * Which libraries a Subsonic user may see, Navidrome's `user_library`
 * verbatim. An admin sees every library whatever the rows say, but is given a
 * row for each anyway, as Navidrome gives them, so a demoted admin keeps what
 * they had. The rows belong to both sides and go with either.
 */
export const userLibrary = sqliteTable(
  "user_library",
  {
    userId: text("user_id")
      .notNull()
      .references(() => subsonicUser.id, { onDelete: "cascade" }),
    libraryId: integer("library_id")
      .notNull()
      .references(() => library.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.libraryId] }),
    // Granting every admin a new library, and its removal, read by library.
    index("user_library_library_id_idx").on(table.libraryId),
  ],
);

export type UserLibrary = typeof userLibrary.$inferSelect;
export type NewUserLibrary = typeof userLibrary.$inferInsert;

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
 * - Albums, tracks and playlists belong to a library by `library_id`, which
 *   migration 0009 added with a default of 1, the bound bucket. Artists have
 *   none: they are shared across libraries (ADR-0009).
 * - Artists, albums and tracks carry no foreign keys. D1 enforces them, and
 *   the scanner writes a track before the album row it belongs to is complete
 *   and deletes in the opposite order; Navidrome likewise keeps that integrity
 *   in the application. The rows that belong to something rather than merely
 *   refer to it - a playlist's entries, a user's annotations and a track's
 *   embedded lyrics - do have one, cascading: an orphan there is not a
 *   passing state during a scan but a row nothing can reach and `getStarred2`
 *   would still count.
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
    /**
     * The library the album's tracks are in, which its id hashes (ADR-0009).
     * Last because `ALTER TABLE` added it, and with no foreign key, like
     * every column of this table.
     */
    libraryId: integer("library_id").notNull().default(1),
  },
  (table) => [
    // `getArtist` lists an artist's albums, and `getArtists` counts them.
    index("album_artist_id_idx").on(table.artistId),
  ],
);

export type Album = typeof album.$inferSelect;
export type NewAlbum = typeof album.$inferInsert;

/**
 * A single playable audio file, identified by its library and its R2 key in
 * that library's bucket.
 *
 * The pair is unique because it is what the track's id is derived from: two
 * rows with the same key in one library would be the same track twice. `etag` together with `size`
 * is the scanner's change signal — R2 ETags of multipart uploads are not MD5s,
 * so neither alone is enough. `contentType` is not stored: it is derived from
 * `suffix` through the one suffix map that also decides what the scanner
 * indexes.
 */
export const track = sqliteTable(
  "track",
  {
    id: text("id").primaryKey(),
    r2Key: text("r2_key").notNull(),
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
    /**
     * The scanner version that last read this track's tags. A row below the
     * scanner's current `SCAN_VERSION` is read again even when its etag and
     * size match, which is how a scanner that learns to read something new
     * (embedded lyrics, #69) reaches the tracks indexed before it did.
     */
    scanVersion: integer("scan_version").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    /**
     * The library whose bucket holds the object. Last because `ALTER TABLE`
     * added it (migration 0009), and with no foreign key: SQLite refuses to
     * add a referencing column with a non-null default while foreign keys are
     * on, and this table keeps none anyway.
     */
    libraryId: integer("library_id").notNull().default(1),
  },
  (table) => [
    // One track per key in each library. It also serves the scan's walk of
    // one library in key order, `library_id = ? and r2_key > ?`.
    uniqueIndex("track_library_id_r2_key_unique").on(table.libraryId, table.r2Key),
    // `getAlbum` lists an album's tracks; the artist index serves the deletion
    // sweep and folder browsing.
    index("track_album_id_idx").on(table.albumId),
    index("track_artist_id_idx").on(table.artistId),
  ],
);

export type Track = typeof track.$inferSelect;
export type NewTrack = typeof track.$inferInsert;

/**
 * The lyrics a track carries in its own tags - ID3v2 `USLT`/`SYLT`, a Vorbis
 * comment's `LYRICS`/`UNSYNCEDLYRICS`, MP4's `©lyr` - which Navidrome keeps
 * in `media_file.lyrics`, filled from the same tags at scan time.
 *
 * A table of its own rather than a column on `track`, because most tracks
 * have none and many queries select whole track rows: a column would carry
 * lyrics into every browse, list and search response path. A row exists only
 * for a track whose tags hold lyrics, so the common case costs nothing, and
 * it belongs to its track: the sweep deleting the track takes it along.
 *
 * `text` is the lyric as the tag holds it - a `SYLT` frame's timed entries
 * written out as LRC - and is parsed when a client asks, by the parser a
 * sidecar goes through, so an LRC-formatted `USLT` is synced exactly as an
 * `.lrc` is. Navidrome parses at scan time and stores the result; storing the
 * source keeps one parser for both. `lang` is the tag's language, `xxx` when
 * it names none, which a `[lang:]` in the text still overrides.
 */
export const trackLyrics = sqliteTable("track_lyrics", {
  trackId: text("track_id")
    .primaryKey()
    .references(() => track.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  lang: text("lang").notNull().default("xxx"),
});

export type TrackLyrics = typeof trackLyrics.$inferSelect;
export type NewTrackLyrics = typeof trackLyrics.$inferInsert;

/**
 * A user-ordered list of tracks, imported from an `.m3u` object in R2.
 *
 * `r2Key` is the key of that `.m3u` in its library's bucket, and with the
 * library is what the playlist's id is derived from, so re-importing an
 * edited file updates the same row. `changedAt` is
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
    r2Key: text("r2_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    changedAt: integer("changed_at", { mode: "timestamp_ms" }).notNull(),
    /** The library the `.m3u` is in, added last as on `track`. */
    libraryId: integer("library_id").notNull().default(1),
  },
  (table) => [
    index("playlist_owner_id_idx").on(table.ownerId),
    // Unique for the same reason a track's key is: the playlist's id is
    // derived from it, so two rows with the same key in one library would be
    // one playlist twice.
    uniqueIndex("playlist_library_id_r2_key_unique").on(table.libraryId, table.r2Key),
  ],
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
      .references(() => subsonicUser.id, { onDelete: "cascade" }),
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
 * Who a user is listening to right now, one row per user: the playback
 * session Navidrome keeps in its play tracker's in-memory cache
 * (`core/scrobbler/play_tracker.go`), stored here because a Worker keeps
 * nothing between requests.
 *
 * `reportPlayback` writes it on `starting`, `playing` and `paused` and deletes
 * it on `stopped`; `scrobble` with `submission=false` writes it as `playing`.
 * `expiresAt` is the instant Navidrome's cache would drop the session - the
 * track's end plus five seconds while playing, half an hour while paused - and
 * `getNowPlaying` reads only the rows before it. A stale row is left to be
 * overwritten in place by the next report rather than swept, so the free tier
 * runs no cleaner.
 *
 * `positionMs` is where the client said it was at `reportedAt`, playing at
 * `playbackRate`; a reader extrapolates the current position from the three.
 * `startedAt` is when the session began, which `minutesAgo` counts from.
 */
export const nowPlaying = sqliteTable("now_playing", {
  userId: text("user_id")
    .primaryKey()
    .references(() => subsonicUser.id, { onDelete: "cascade" }),
  trackId: text("track_id").notNull(),
  /** The client's `c` parameter, shown in the now-playing feed. */
  playerName: text("player_name").notNull().default(""),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  /** `starting`, `playing` or `paused`: a stopped session has no row. */
  state: text("state").notNull().default("playing"),
  positionMs: integer("position_ms").notNull().default(0),
  playbackRate: real("playback_rate").notNull().default(1),
  /** When the last report was stored; 0 on a row from before the column. */
  reportedAt: integer("reported_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
  /** When the session stops being current; 0 on a row from before the column. */
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
});

export type NowPlaying = typeof nowPlaying.$inferSelect;
export type NewNowPlaying = typeof nowPlaying.$inferInsert;

/**
 * The play queue a listener carries between devices, one row per user — as
 * Navidrome keeps one queue per user (`model/playqueue.go`, whose repository
 * clears the user's queue before storing the new one).
 *
 * `savePlayQueue` replaces the whole row and `getPlayQueue` reads it back in
 * one statement, so the queue is stored the way it arrives: `trackIds` is the
 * ordered list of track ids as a JSON array of strings, not a row per entry.
 * A queue is written and read whole and never queried into, and one statement
 * rather than one per entry is what keeps a long queue inside the free tier's
 * subrequest budget.
 *
 * `current` is the track the listener is on — null when the client names none
 * — and `position` is how far into it, in milliseconds, the unit Subsonic's
 * `position` parameter carries. `changedBy` is the client's `c` parameter, so
 * the next device can tell which client left the queue behind.
 */
export const playQueue = sqliteTable("play_queue", {
  userId: text("user_id")
    .primaryKey()
    .references(() => subsonicUser.id, { onDelete: "cascade" }),
  /** The queue in order, a JSON array of bare track ids. */
  trackIds: text("track_ids").notNull().default("[]"),
  current: text("current"),
  /** Milliseconds into the current track. */
  position: integer("position").notNull().default(0),
  /** The client's `c` parameter, which `getPlayQueue` answers with. */
  changedBy: text("changed_by").notNull().default(""),
  changedAt: integer("changed_at", { mode: "timestamp_ms" }).notNull(),
});

export type PlayQueue = typeof playQueue.$inferSelect;
export type NewPlayQueue = typeof playQueue.$inferInsert;

/**
 * Where a listener stopped in one track, so any client can offer to resume
 * there — Navidrome's `bookmark` table (`model/bookmark.go`), keyed by the
 * user and the item.
 *
 * `position` is milliseconds into the track, the unit Subsonic's `position`
 * parameter carries, and `comment` is whatever note the client attached.
 * `createdAt` is when the bookmark was first made and `changedAt` when it was
 * last moved: `createBookmark` on a track that is already bookmarked updates
 * the position and the comment and keeps the original instant, which is what
 * the `created`/`changed` pair `getBookmarks` answers with means.
 *
 * Navidrome's key carries an `item_type` alongside the id, because it also
 * bookmarks podcast episodes; a Stratosonic library holds nothing but tracks,
 * so the key is (user, track) and the track id needs no qualifier. The rows
 * belong to their user and go when the user does.
 */
export const bookmark = sqliteTable(
  "bookmark",
  {
    userId: text("user_id")
      .notNull()
      .references(() => subsonicUser.id, { onDelete: "cascade" }),
    trackId: text("track_id").notNull(),
    /** Milliseconds into the track. */
    position: integer("position").notNull().default(0),
    comment: text("comment").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    changedAt: integer("changed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.trackId] })],
);

export type Bookmark = typeof bookmark.$inferSelect;
export type NewBookmark = typeof bookmark.$inferInsert;
