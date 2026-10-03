import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import * as schema from "@stratosonic/db";
import { albumId, artistId, playlistId, trackId } from "@stratosonic/db";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 0009 (#84, #144) over a library a deployed v0.5.0 has indexed:
 * tracks with lyrics, albums, playlists with entries, annotations, bookmarks,
 * a play queue, a playback session, and an admin and a listener.
 *
 * D1 enforces foreign keys and cannot turn them off, so a migration that
 * dropped or rebuilt `track` or `playlist` would fire the ON DELETE CASCADE of
 * `track_lyrics` and `playlist_track` and lose them. 0009 rebuilds nothing:
 * it swaps the key's unique index in place and adds `library_id` with a
 * default of 1. This file proves every row survives, with its id, in library
 * 1, and that the schema it leaves is the one `schema.ts` declares
 * (packages/db's snapshot test proves drizzle-kit agrees with `schema.ts`).
 *
 * It runs against `MIGRATION_DB`, which the setup file leaves empty
 * (vitest.config.ts), as migration-0008.test.ts does.
 */

interface MigrationBindings {
  TEST_MIGRATIONS: D1Migration[];
  MIGRATION_DB: D1Database;
}

const { TEST_MIGRATIONS, MIGRATION_DB } = env as unknown as MigrationBindings;

const db = MIGRATION_DB;

const KEYS = [
  "Aphex Twin/Selected Ambient Works 85-92/01 Xtal.mp3",
  "Aphex Twin/Selected Ambient Works 85-92/02 Tha.mp3",
  "Aphex Twin/Drukqs/01 Jynweythek.flac",
] as const;
const [XTAL, THA, JYNWEYTHEK] = KEYS.map((key) => trackId(1, key)) as [string, string, string];
const ARTIST = artistId("Aphex Twin");
const SAW = albumId(1, "Aphex Twin", "Selected Ambient Works 85-92", 1992);
const DRUKQS = albumId(1, "Aphex Twin", "Drukqs", 2001);
const MIX = playlistId(1, "playlists/mix.m3u");
const QUIET = playlistId(1, "playlists/quiet.m3u");

/** The tables 0009 adds `library_id` to. */
const LIBRARY_TABLES = ["album", "track", "playlist"] as const;

/** Every table a deployed server has rows in, in the order they are compared. */
const SEEDED_TABLES = [
  "subsonic_user",
  "artist",
  ...LIBRARY_TABLES,
  "track_lyrics",
  "playlist_track",
  "annotation",
  "bookmark",
  "play_queue",
  "now_playing",
] as const;

async function all(sql: string): Promise<Record<string, unknown>[]> {
  return (await db.prepare(sql).all<Record<string, unknown>>()).results;
}

/** Every row of every seeded table, in a stable order. */
async function rows(): Promise<Record<string, Record<string, unknown>[]>> {
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const table of SEEDED_TABLES) {
    result[table] = await all(`SELECT * FROM ${table} ORDER BY 1, 2, 3`);
  }
  return result;
}

let before: Record<string, Record<string, unknown>[]>;

beforeAll(async () => {
  const upTo0008 = TEST_MIGRATIONS.filter((migration) => migration.name < "0009");
  expect(upTo0008).toHaveLength(9);
  await applyD1Migrations(db, upTo0008);

  const track = (id: string, key: string, album: string, title: string) =>
    db
      .prepare(
        `INSERT INTO track (id, r2_key, title, album_id, artist_id, artist, album_artist, suffix,
           duration, size, etag, scan_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'Aphex Twin', 'Aphex Twin', ?, 120.5, 4096, ?, 1, 1000, 2000)`,
      )
      .bind(id, key, title, album, ARTIST, key.split(".").at(-1), `etag-${title}`);

  await db.batch([
    db.prepare(
      `INSERT INTO subsonic_user (id, user_name, name, password, is_admin, created_at, updated_at)
       VALUES ('user-admin', 'Admin', 'Admin', 'ciphertext-a', 1, 1, 1),
              ('user-listener', 'Listener', 'Listener', 'ciphertext-l', 0, 2, 2)`,
    ),
    db
      .prepare(
        "INSERT INTO artist (id, name, created_at, updated_at) VALUES (?, 'Aphex Twin', 1, 1)",
      )
      .bind(ARTIST),
    db
      .prepare(
        `INSERT INTO album (id, name, artist_id, album_artist, year, song_count, duration, size,
           cover_key, created_at, updated_at)
         VALUES (?, 'Selected Ambient Works 85-92', ?, 'Aphex Twin', 1992, 2, 241, 8192, ?, 1, 1),
                (?, 'Drukqs', ?, 'Aphex Twin', 2001, 1, 120.5, 4096, NULL, 1, 1)`,
      )
      .bind(SAW, ARTIST, `_covers/${SAW}.jpg`, DRUKQS, ARTIST),
    track(XTAL, KEYS[0], SAW, "Xtal"),
    track(THA, KEYS[1], SAW, "Tha"),
    track(JYNWEYTHEK, KEYS[2], DRUKQS, "Jynweythek"),
    db
      .prepare(
        "INSERT INTO track_lyrics (track_id, text, lang) VALUES (?, '[00:01.00]la', 'eng'), (?, 'hm', 'xxx')",
      )
      .bind(XTAL, JYNWEYTHEK),
    db
      .prepare(
        `INSERT INTO playlist (id, name, owner_id, public, song_count, duration, r2_key, created_at, changed_at)
         VALUES (?, 'Mix', 'user-admin', 1, 3, 361.5, 'playlists/mix.m3u', 1, 2),
                (?, 'Quiet', 'user-listener', 0, 1, 120.5, 'playlists/quiet.m3u', 1, 2)`,
      )
      .bind(MIX, QUIET),
    // One track twice in one playlist.
    db
      .prepare(
        "INSERT INTO playlist_track (playlist_id, track_id, position) VALUES (?1, ?2, 0), (?1, ?3, 1), (?1, ?2, 2), (?4, ?5, 0)",
      )
      .bind(MIX, XTAL, THA, QUIET, JYNWEYTHEK),
    db
      .prepare(
        `INSERT INTO annotation (user_id, item_id, item_type, starred, starred_at, rating, play_count, play_date)
         VALUES ('user-admin', ?, 'track', 1, 5, 4, 7, 6),
                ('user-admin', ?, 'album', 0, NULL, 5, 0, NULL),
                ('user-listener', ?, 'artist', 1, 9, 0, 0, NULL),
                ('user-listener', ?, 'playlist', 1, 9, 0, 0, NULL)`,
      )
      .bind(XTAL, SAW, ARTIST, MIX),
    db
      .prepare(
        "INSERT INTO bookmark (user_id, track_id, position, comment, created_at, changed_at) VALUES ('user-listener', ?, 42000, 'here', 3, 4)",
      )
      .bind(THA),
    db
      .prepare(
        "INSERT INTO play_queue (user_id, track_ids, current, position, changed_by, changed_at) VALUES ('user-listener', ?, ?, 1500, 'substreamer', 5)",
      )
      .bind(JSON.stringify([XTAL, THA, XTAL]), THA),
    db
      .prepare(
        "INSERT INTO now_playing (user_id, track_id, player_name, started_at, state, position_ms, reported_at, expires_at) VALUES ('user-admin', ?, 'substreamer', 1, 'playing', 10, 2, 3)",
      )
      .bind(JYNWEYTHEK),
  ]);

  before = await rows();
  expect(before.track_lyrics).toHaveLength(2);
  expect(before.playlist_track).toHaveLength(4);

  await applyD1Migrations(db, TEST_MIGRATIONS);
});

describe("migration 0009 over a v0.5.0 library", () => {
  it("keeps every row with its id, and puts each album, track and playlist in library 1", async () => {
    const after = await rows();

    for (const table of SEEDED_TABLES) {
      const expected = (LIBRARY_TABLES as readonly string[]).includes(table)
        ? before[table]?.map((row) => ({ ...row, library_id: 1 }))
        : before[table];
      expect(after[table], table).toEqual(expected);
    }
    expect(after.track?.map((row) => row.id).sort()).toEqual([XTAL, THA, JYNWEYTHEK].sort());
    expect(after.album?.map((row) => row.id).sort()).toEqual([SAW, DRUKQS].sort());
    expect(after.playlist?.map((row) => row.id).sort()).toEqual([MIX, QUIET].sort());
  });

  it("fires no cascade: the lyrics and the playlist entries are all there", async () => {
    expect(await all("SELECT track_id, lang FROM track_lyrics ORDER BY track_id")).toEqual(
      [
        { track_id: XTAL, lang: "eng" },
        { track_id: JYNWEYTHEK, lang: "xxx" },
      ].sort((a, b) => a.track_id.localeCompare(b.track_id)),
    );
    expect(
      await all(
        `SELECT track_id FROM playlist_track WHERE playlist_id = '${MIX}' ORDER BY position`,
      ),
    ).toEqual([{ track_id: XTAL }, { track_id: THA }, { track_id: XTAL }]);
  });

  it("leaves no broken foreign key, and every foreign key as the schema declares it", async () => {
    expect(await all("PRAGMA foreign_key_check")).toEqual([]);
    expect(await databaseForeignKeys()).toEqual(declaredForeignKeys());
  });

  it("still enforces the foreign keys, so a cascade would have fired", async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO track (id, r2_key, title, album_id, artist_id, artist, album_artist, suffix, created_at, updated_at)
         VALUES ('doomed', 'Doomed/Doomed/01.mp3', 'Doomed', 'a', 'a', 'a', 'a', 'mp3', 0, 0)`,
      ),
      db.prepare("INSERT INTO track_lyrics (track_id, text) VALUES ('doomed', 'gone')"),
    ]);

    await db.prepare("DELETE FROM track WHERE id = 'doomed'").run();

    expect(await all("SELECT * FROM track_lyrics WHERE track_id = 'doomed'")).toEqual([]);
    await expect(
      db.prepare("INSERT INTO track_lyrics (track_id, text) VALUES ('nothing', 'orphan')").run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("creates library 1, the bound bucket, named Music Library", async () => {
    const libraries = await all("SELECT * FROM library");

    expect(libraries).toEqual([
      {
        id: 1,
        name: "Music Library",
        path: "r2-binding://MUSIC",
        kind: "r2-binding",
        endpoint: null,
        region: null,
        bucket: null,
        credentials: null,
        writable: 1,
        default_new_users: 1,
        state: "active",
        last_scan_started_at: null,
        last_scan_at: null,
        last_scan_error: null,
        created_at: expect.any(Number),
        updated_at: libraries[0]?.created_at,
      },
    ]);
    // Epoch milliseconds, as every timestamp in the database is.
    expect(Math.abs(Number(libraries[0]?.created_at) - Date.now())).toBeLessThan(10 * 60_000);
  });

  it("gives both users library 1, the admin too, as Navidrome's backfill does", async () => {
    expect(await all("SELECT user_id, library_id FROM user_library ORDER BY user_id")).toEqual([
      { user_id: "user-admin", library_id: 1 },
      { user_id: "user-listener", library_id: 1 },
    ]);
  });

  it("takes the same key in library 2, but not twice in library 1", async () => {
    const insertTrack = (id: string, libraryId: number) =>
      db
        .prepare(
          `INSERT INTO track (id, r2_key, title, album_id, artist_id, artist, album_artist, suffix, created_at, updated_at, library_id)
           VALUES (?, ?, 'Xtal', ?, ?, 'Aphex Twin', 'Aphex Twin', 'mp3', 0, 0, ?)`,
        )
        .bind(id, KEYS[0], SAW, ARTIST, libraryId)
        .run();
    const insertPlaylist = (id: string, libraryId: number) =>
      db
        .prepare(
          `INSERT INTO playlist (id, name, owner_id, r2_key, created_at, changed_at, library_id)
           VALUES (?, 'Mix', 'user-admin', 'playlists/mix.m3u', 0, 0, ?)`,
        )
        .bind(id, libraryId)
        .run();

    await insertTrack(trackId(2, KEYS[0]), 2);
    await insertPlaylist(playlistId(2, "playlists/mix.m3u"), 2);

    await expect(insertTrack("another-id", 1)).rejects.toThrow(
      /UNIQUE constraint failed: track\.library_id, track\.r2_key/,
    );
    await expect(insertPlaylist("another-id", 1)).rejects.toThrow(
      /UNIQUE constraint failed: playlist\.library_id, playlist\.r2_key/,
    );
    expect(await all("SELECT library_id, count(*) AS n FROM track GROUP BY library_id")).toEqual([
      { library_id: 1, n: 3 },
      { library_id: 2, n: 1 },
    ]);
  });

  it("serves a walk of one library in key order from the new unique index", async () => {
    const plan = await all(
      "EXPLAIN QUERY PLAN SELECT id FROM track WHERE library_id = 1 AND r2_key > '' ORDER BY r2_key",
    );

    expect(plan.map((step) => step.detail).join("\n")).toMatch(
      /USING (COVERING )?INDEX track_library_id_r2_key_unique \(library_id=\? AND r2_key>\?\)/,
    );
  });

  it("names libraries uniquely ignoring case, and never reuses an id", async () => {
    const insert = (name: string, path: string) =>
      db
        .prepare(
          "INSERT INTO library (name, path, kind, created_at, updated_at) VALUES (?, ?, 's3', 0, 0) RETURNING id",
        )
        .bind(name, path)
        .first<{ id: number }>();

    await expect(insert("music library", "s3://elsewhere/one")).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    await expect(insert("Elsewhere", "r2-binding://MUSIC")).rejects.toThrow(
      /UNIQUE constraint failed: library\.path/,
    );
    const archive = await insert("Archive", "s3://acct.r2.cloudflarestorage.com/archive");
    await db.prepare("DELETE FROM library WHERE id = ?").bind(archive?.id).run();
    const next = await insert("Archive", "s3://acct.r2.cloudflarestorage.com/archive");

    expect(archive?.id).toBe(2);
    expect(next?.id).toBe(3);
  });

  it("leaves the tables, columns and indexes schema.ts declares", async () => {
    for (const table of declaredTables()) {
      const config = getTableConfig(table);
      const columns = await all(
        `SELECT name, "notnull", pk FROM pragma_table_xinfo('${config.name}') ORDER BY name`,
      );
      const indexes = await all(
        `SELECT name, "unique" FROM pragma_index_list('${config.name}') WHERE origin = 'c' ORDER BY name`,
      );

      expect(columns, config.name).toEqual(
        config.columns
          .map((column) => ({
            name: column.name,
            notnull: column.notNull ? 1 : 0,
            pk: column.primary
              ? 1
              : (config.primaryKeys[0]?.columns.findIndex((key) => key.name === column.name) ??
                  -1) + 1,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      expect(indexes, config.name).toEqual(
        [
          ...config.indexes.map((index) => ({
            name: index.config.name,
            unique: index.config.unique ? 1 : 0,
          })),
          ...config.columns
            .filter((column) => column.isUnique)
            .map((column) => ({ name: column.uniqueName, unique: 1 })),
        ].sort((a, b) => String(a.name).localeCompare(String(b.name))),
      );
    }

    const tables = await all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
    );
    expect(tables.map((row) => row.name)).toEqual(
      declaredTables()
        .map((table) => getTableConfig(table).name)
        .sort(),
    );
  });
});

/** Every table `schema.ts` declares. */
function declaredTables(): SQLiteTable[] {
  return Object.values(schema as Record<string, unknown>).filter((value): value is SQLiteTable =>
    is(value, SQLiteTable),
  );
}

interface ForeignKey {
  from: string;
  column: string;
  table: string;
  to: string;
  onUpdate: string;
  onDelete: string;
}

/** Every foreign key `schema.ts` declares, as SQLite reports one. */
function declaredForeignKeys(): ForeignKey[] {
  return declaredTables()
    .flatMap((table) => {
      const config = getTableConfig(table);
      return config.foreignKeys.flatMap((key) => {
        const reference = key.reference();
        return reference.columns.map((column, index) => ({
          from: config.name,
          column: column.name,
          table: getTableConfig(reference.foreignTable).name,
          to: reference.foreignColumns[index]?.name ?? "",
          onUpdate: (key.onUpdate ?? "no action").toUpperCase(),
          onDelete: (key.onDelete ?? "no action").toUpperCase(),
        }));
      });
    })
    .sort(byForeignKey);
}

/**
 * Every foreign key the migrated database has, in its tables (D1 refuses
 * access to its own `_cf_` tables).
 */
async function databaseForeignKeys(): Promise<ForeignKey[]> {
  const keys = await all(
    `SELECT m.name AS "from", f."from" AS "column", f."table", f."to", f.on_update AS onUpdate, f.on_delete AS onDelete
       FROM sqlite_master m, pragma_foreign_key_list(m.name) f
      WHERE m.type = 'table' AND m.name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`,
  );
  return (keys as unknown as ForeignKey[]).sort(byForeignKey);
}

function byForeignKey(a: ForeignKey, b: ForeignKey): number {
  return `${a.from}.${a.column}`.localeCompare(`${b.from}.${b.column}`);
}
