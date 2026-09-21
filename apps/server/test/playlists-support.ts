import { SELF } from "cloudflare:test";
import { type Playlist, type PlaylistTrack, playlist, playlistTrack } from "@stratosonic/db";
import { asc } from "drizzle-orm";
import { database } from "../src/db";
import type { Env } from "../src/env";
import {
  DEFAULT_PLAYLIST_IMPORT_LIMITS,
  importPlaylists,
  type PlaylistImportLimits,
  type PlaylistImportRun,
} from "../src/playlists/import";
import type { SubsonicSongElement } from "./browsing-support";
import { query } from "./browsing-support";
import { SCAN_TIME } from "./scan-support";
import { BASE, testEnv } from "./support";

/**
 * Driving the playlist import from a test, and reading back what it wrote.
 *
 * The import is reached through `importPlaylists`, which the `scheduled`
 * entry calls after the scan; what it *produced* is asserted through the
 * `fetch` handler like everything else, and the row helpers below exist only
 * for the few columns no endpoint renders.
 */

/** `<playlist>` as the JSON rendering carries it. */
export interface SubsonicPlaylistElement {
  id: string;
  name: string;
  comment?: string;
  songCount: number;
  duration: number;
  public: boolean;
  owner?: string;
  created: string;
  changed: string;
  coverArt?: string;
  entry?: SubsonicSongElement[];
}

export interface PlaylistsResponse {
  status: string;
  error?: { code: number; message: string };
  playlists?: { playlist?: SubsonicPlaylistElement[] };
  playlist?: SubsonicPlaylistElement;
}

/** One run of the import, with whichever limits the test needs. */
export function importRun(
  now: Date = SCAN_TIME,
  limits: Partial<PlaylistImportLimits> = {},
): Promise<PlaylistImportRun> {
  return importPlaylists(testEnv, now, { ...DEFAULT_PLAYLIST_IMPORT_LIMITS, ...limits });
}

/** One statement D1 ran, and the rows it reported writing for it. */
export interface RecordedWrite {
  /** The SQL as Drizzle prepared it, which is how the table is recognised. */
  readonly sql: string;
  /** D1's own `meta.rows_written`, index rows included, as the bill counts it. */
  readonly rowsWritten: number;
}

/** One run of the import, with what it cost D1. */
export interface CountedImport {
  readonly run: PlaylistImportRun;
  /** Every statement the run executed, in order. */
  readonly writes: readonly RecordedWrite[];
  /** Rows written to `playlist` and `playlist_track`: what #61 is about. */
  readonly playlistRowsWritten: number;
  /** The parameter count of every statement, as the scan's helper records it. */
  readonly boundCounts: readonly number[];
  /** How many statements the run ran against this table, read or write. */
  statementsAgainst(table: string): number;
}

/**
 * Runs the import against a D1 that reports what every statement wrote.
 *
 * The free tier allows 100,000 rows written a day, and an import that
 * rewrites every entry of every playlist on every pass spends them (#61), so
 * a test has to be able to say "this pass wrote nothing" rather than only
 * "this pass left the rows looking the same".
 *
 * Drizzle reaches D1 through `prepare(sql).bind(...).run()/all()` and through
 * `batch`, so wrapping the two catches every statement, batched or not; the
 * wrapped statements are the real ones, so the import still runs against real
 * storage. `rows_written` is D1's own number, which counts the index rows a
 * write touches as well as the table rows - a test therefore asks whether it
 * is zero, not what it is.
 */
export async function importCountingWrites(
  now: Date = SCAN_TIME,
  limits: Partial<PlaylistImportLimits> = {},
): Promise<CountedImport> {
  const writes: RecordedWrite[] = [];
  const boundCounts: number[] = [];
  const queries = new WeakMap<D1PreparedStatement, string>();

  const record = (sql: string, rowsWritten: number) => {
    writes.push({ sql, rowsWritten });
  };

  const counted = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => {
            boundCounts.push(values.length);

            return counted(target.bind(...values), sql);
          };
        }

        if (property === "run" || property === "all") {
          return async () => {
            const result = property === "run" ? await target.run() : await target.all();
            record(sql, result.meta.rows_written);

            return result;
          };
        }

        // How Drizzle reads a select it maps itself. It answers with rows and
        // no meta, so it writes nothing by construction - but it is still a
        // statement, and the cost of the reads this fix adds is the other
        // half of #61.
        if (property === "raw") {
          return async () => {
            const rows = await target.raw();
            record(sql, 0);

            return rows;
          };
        }

        const value = Reflect.get(target, property, target);

        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    queries.set(proxy, sql);

    return proxy;
  };

  const db = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => counted(target.prepare(sql), sql);
      }

      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          for (const [index, result] of results.entries()) {
            const statement = statements[index];
            record(
              statement === undefined ? "" : (queries.get(statement) ?? ""),
              result.meta.rows_written,
            );
          }

          return results;
        };
      }

      const value = Reflect.get(target, property, target);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const env: Env = { ...testEnv, DB: db };
  const run = await importPlaylists(env, now, { ...DEFAULT_PLAYLIST_IMPORT_LIMITS, ...limits });

  return {
    run,
    writes,
    boundCounts,
    playlistRowsWritten: rowsWrittenToPlaylists(writes),
    statementsAgainst: (table) => writes.filter((write) => write.sql.includes(`"${table}"`)).length,
  };
}

/** How many rows a run wrote to the two playlist tables and nowhere else. */
function rowsWrittenToPlaylists(writes: readonly RecordedWrite[]): number {
  return writes
    .filter((write) => /"playlist"|"playlist_track"/.test(write.sql))
    .reduce((total, write) => total + write.rowsWritten, 0);
}

/**
 * Runs the import until a pass completes, and hands back every run it took.
 * A cron spreads these over as many invocations as a bucket needs; a test
 * does not want to wait a quarter of an hour between them.
 */
export async function importUntilComplete(
  limits: Partial<PlaylistImportLimits> = {},
  now: Date = SCAN_TIME,
): Promise<PlaylistImportRun[]> {
  const runs: PlaylistImportRun[] = [];

  // A pass that has not finished after this many runs is a loop, not a pass.
  for (let attempt = 0; attempt < 50; attempt++) {
    const run = await importRun(now, limits);
    runs.push(run);
    if (run.completed) {
      return runs;
    }
  }

  throw new Error("the playlist import never completed");
}

/** Calls a playlist endpoint as the bootstrap admin and reads the JSON answer. */
export async function playlists(
  endpoint: string,
  extra: Record<string, string> = {},
): Promise<PlaylistsResponse> {
  const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${query({ ...extra, f: "json" })}`);
  const body = (await response.json()) as { "subsonic-response": PlaylistsResponse };

  return body["subsonic-response"];
}

/** Every playlist row, by key, for the columns no endpoint renders. */
export function storedPlaylists(): Promise<Playlist[]> {
  return database(testEnv).select().from(playlist).orderBy(asc(playlist.r2Key));
}

/** Every entry row, in playlist and then position order. */
export function storedEntries(): Promise<PlaylistTrack[]> {
  return database(testEnv)
    .select()
    .from(playlistTrack)
    .orderBy(asc(playlistTrack.playlistId), asc(playlistTrack.position));
}

/** Writes an `.m3u` into the bucket, and says what R2 then knows about it. */
export async function putPlaylistObject(
  key: string,
  text: string,
): Promise<{ uploaded: Date; etag: string }> {
  const stored = await testEnv.MUSIC.put(key, new TextEncoder().encode(text));
  if (!stored) {
    throw new Error(`R2 refused ${key}`);
  }

  return { uploaded: stored.uploaded, etag: stored.etag };
}

/**
 * The attribute names of the first element of this name in a rendered XML
 * document, in the order the document carries them. Navidrome's attribute
 * order is part of what a strict client reads, so a test says it out loud.
 */
/** Credentials a call is made with; the bootstrap admin unless a test says. */
export interface PlaylistCaller {
  readonly user: string;
  readonly password: string;
}

export const ADMIN_CALLER: PlaylistCaller = { user: "admin", password: "sesame" };

/**
 * Calls a playlist endpoint with parameters that may repeat - `songId` does -
 * as whichever account the test names.
 */
export async function callPlaylists(
  endpoint: string,
  parameters: readonly (readonly [string, string])[],
  caller: PlaylistCaller = ADMIN_CALLER,
): Promise<PlaylistsResponse> {
  const params = new URLSearchParams({
    u: caller.user,
    p: caller.password,
    v: "1.16.1",
    c: "Substreamer",
    f: "json",
  });
  for (const [name, value] of parameters) {
    params.append(name, value);
  }

  const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${params.toString()}`);
  const body = (await response.json()) as { "subsonic-response": PlaylistsResponse };

  return body["subsonic-response"];
}

/** Every object the bucket holds under a prefix, with its text, by key. */
export async function playlistObjects(prefix = "playlists/"): Promise<Map<string, string>> {
  const listing = await testEnv.MUSIC.list({ prefix });
  const objects = new Map<string, string>();

  for (const object of listing.objects) {
    const stored = await testEnv.MUSIC.get(object.key);
    objects.set(object.key, stored === null ? "" : await stored.text());
  }

  return objects;
}

export function attributeNames(xml: string, element: string): string[] {
  const match = new RegExp(`<${element}\\s([^>]*?)/?>`).exec(xml);
  if (!match?.[1]) {
    throw new Error(`no <${element}> with attributes in ${xml}`);
  }

  return [...match[1].matchAll(/([A-Za-z0-9]+)="/g)].map((attribute) => attribute[1] ?? "");
}
