import { SELF } from "cloudflare:test";
import { type Playlist, type PlaylistTrack, playlist, playlistTrack } from "@stratosonic/db";
import { asc } from "drizzle-orm";
import { database } from "../src/db";
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
