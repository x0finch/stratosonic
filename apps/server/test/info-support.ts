import { SELF } from "cloudflare:test";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { query, type SubsonicSongElement } from "./browsing-support";
import { type RecordedWrite, recordingDatabase } from "./playlists-support";
import { BASE, testEnv } from "./support";

/**
 * What the info and similar-songs tests send and read back, and what one of
 * those requests costs D1.
 *
 * The element shapes are the JSON rendering of Navidrome's `ArtistInfo`,
 * `ArtistInfo2`, `AlbumInfo`, `SimilarSongs` and `SimilarSongs2`
 * (server/subsonic/responses/responses.go): the text fields are bare strings,
 * and every one of them is `omitempty`.
 */

export interface SubsonicInfoElement {
  biography?: string;
  notes?: string;
  musicBrainzId?: string;
  lastFmUrl?: string;
  smallImageUrl?: string;
  mediumImageUrl?: string;
  largeImageUrl?: string;
  similarArtist?: unknown[];
}

export interface InfoResponse {
  status: string;
  error?: { code: number; message: string };
  artistInfo?: SubsonicInfoElement;
  artistInfo2?: SubsonicInfoElement;
  albumInfo?: SubsonicInfoElement;
  similarSongs?: { song?: SubsonicSongElement[] };
  similarSongs2?: { song?: SubsonicSongElement[] };
}

/** Calls an endpoint as the bootstrap admin, by GET, and reads the JSON answer. */
export async function info(
  endpoint: string,
  extra: Record<string, string> = {},
): Promise<InfoResponse> {
  const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${query({ ...extra, f: "json" })}`);
  const body = (await response.json()) as { "subsonic-response": InfoResponse };

  return body["subsonic-response"];
}

/**
 * Calls an endpoint by form POST, credentials and all in the body and nothing
 * in the query, and answers with the raw text so either rendering can be read.
 */
export async function infoPost(
  path: string,
  extra: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: query(extra),
  });

  return response.text();
}

/** One request, with every D1 statement it ran and the rows they wrote. */
export interface CountedInfoRequest {
  readonly body: InfoResponse;
  /** Every D1 statement the request ran, authentication included. */
  readonly statements: readonly RecordedWrite[];
  readonly rowsWritten: number;
}

/**
 * Calls an endpoint through the app with a D1 that records every statement.
 *
 * The last-access record is written at most once a minute per user and
 * isolate, so a ping goes first: it pays that write, and what is counted is
 * then the request alone.
 */
export async function infoCounting(
  endpoint: string,
  extra: Record<string, string>,
): Promise<CountedInfoRequest> {
  const app = createApp();
  await app.fetch(new Request(`${BASE}/rest/ping?${query()}`), testEnv);

  const statements: RecordedWrite[] = [];
  const env: Env = { ...testEnv, DB: recordingDatabase(statements) };
  const response = await app.fetch(
    new Request(`${BASE}/rest/${endpoint}?${query({ ...extra, f: "json" })}`),
    env,
  );
  const body = (await response.json()) as { "subsonic-response": InfoResponse };

  return {
    body: body["subsonic-response"],
    statements,
    rowsWritten: statements.reduce((total, statement) => total + statement.rowsWritten, 0),
  };
}

/** The titles of a song list, in order, for a test to state what came back. */
export function titles(songs: readonly SubsonicSongElement[] | undefined): string[] {
  return (songs ?? []).map((song) => song.title);
}
