import { SELF } from "cloudflare:test";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { query } from "./browsing-support";
import { type RecordedWrite, recordingDatabase } from "./playlists-support";
import { BASE, testEnv } from "./support";

/**
 * What the lyrics tests send and read back, and what a lyrics request costs.
 *
 * The element shapes are the JSON rendering of Navidrome's
 * `responses.StructuredLyric` and `responses.Lyrics`.
 */

export interface SubsonicLyricLine {
  start?: number;
  value: string;
}

export interface SubsonicStructuredLyrics {
  displayArtist?: string;
  displayTitle?: string;
  lang: string;
  line: SubsonicLyricLine[];
  offset?: number;
  synced: boolean;
}

export interface LyricsResponse {
  status: string;
  error?: { code: number; message: string };
  lyricsList?: { structuredLyrics?: SubsonicStructuredLyrics[] };
  lyrics?: { artist?: string; title?: string; value: string };
}

/** Calls a lyrics endpoint as the bootstrap admin and reads the JSON answer. */
export async function lyrics(
  endpoint: string,
  extra: Record<string, string> = {},
): Promise<LyricsResponse> {
  const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${query({ ...extra, f: "json" })}`);
  const body = (await response.json()) as { "subsonic-response": LyricsResponse };

  return body["subsonic-response"];
}

/** Puts a sidecar in the bucket, as text or as the bytes a test built. */
export async function putSidecar(key: string, content: string | Uint8Array): Promise<void> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  if (!(await testEnv.MUSIC.put(key, bytes))) {
    throw new Error(`R2 refused ${key}`);
  }
}

/** One lyrics request, with what it cost D1 and R2. */
export interface CountedLyricsRequest {
  readonly body: LyricsResponse;
  /** Every D1 statement the request ran, authentication included. */
  readonly statements: readonly RecordedWrite[];
  /** The rows those statements wrote, as D1 bills them. */
  readonly rowsWritten: number;
  /** The keys the request read from R2, in order. */
  readonly r2Gets: readonly string[];
}

/**
 * Calls a lyrics endpoint through the app with a D1 that records every
 * statement and an R2 that records every read - and fails the reads of the
 * keys a test names, the way a bucket that is having a bad moment would.
 *
 * The last-access record is written at most once a minute per user and
 * isolate, so a ping goes first: it pays that write, and what is counted
 * is then the lyrics request alone.
 */
export async function lyricsCounting(
  endpoint: string,
  extra: Record<string, string>,
  failingKeys: ReadonlySet<string> = new Set(),
): Promise<CountedLyricsRequest> {
  const app = createApp();
  await app.fetch(new Request(`${BASE}/rest/ping?${query()}`), testEnv);

  const statements: RecordedWrite[] = [];
  const r2Gets: string[] = [];
  const music = new Proxy(testEnv.MUSIC, {
    get(target, property) {
      if (property === "get") {
        return async (key: string, options?: R2GetOptions) => {
          r2Gets.push(key);
          if (failingKeys.has(key)) {
            throw new Error(`R2 could not produce ${key}`);
          }

          return target.get(key, options);
        };
      }

      const value = Reflect.get(target, property, target);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const env: Env = { ...testEnv, DB: recordingDatabase(statements), MUSIC: music };
  const response = await app.fetch(
    new Request(`${BASE}/rest/${endpoint}?${query({ ...extra, f: "json" })}`),
    env,
  );
  const body = (await response.json()) as { "subsonic-response": LyricsResponse };

  return {
    body: body["subsonic-response"],
    statements,
    rowsWritten: statements.reduce((total, statement) => total + statement.rowsWritten, 0),
    r2Gets,
  };
}
