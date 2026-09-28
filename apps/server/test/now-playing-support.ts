import { createExecutionContext, SELF } from "cloudflare:test";
import { nowPlaying } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { database } from "../src/db";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { StoredSession } from "../src/nowplaying/session";
import { findUserByUsername } from "../src/users/repository";
import { type WriteResponse, writeQuery } from "./annotations-support";
import { ADMIN, type SubsonicSongElement } from "./browsing-support";
import { type RecordedWrite, recordingDatabase } from "./playlists-support";
import { BASE, testEnv } from "./support";

/**
 * Reading and writing the caller's playback session, for the `scrobble`,
 * `reportPlayback` and `getNowPlaying` tests: the feed as a client reads it,
 * the row as D1 holds it, and what one report cost D1.
 */

/** One `getNowPlaying` entry, as the JSON rendering carries it. */
export interface NowPlayingEntry extends SubsonicSongElement {
  username: string;
  minutesAgo: number;
  playerId: number;
  playerName?: string;
  state?: string;
  positionMs?: number;
  playbackRate?: number;
}

/** Reads getNowPlaying as the bootstrap admin. */
export async function nowPlayingFeed(): Promise<NowPlayingEntry[]> {
  const response = await SELF.fetch(`${BASE}/rest/getNowPlaying?${writeQuery({ f: "json" })}`);
  const body = (await response.json()) as {
    "subsonic-response": { nowPlaying?: { entry?: NowPlayingEntry[] } };
  };

  return body["subsonic-response"].nowPlaying?.entry ?? [];
}

/** The bootstrap admin's user id, which their session is keyed by. */
export async function adminId(): Promise<string> {
  const admin = await findUserByUsername(database(testEnv), ADMIN);
  if (!admin) {
    throw new Error("the bootstrap admin is missing");
  }

  return admin.id;
}

/** The admin's stored session, or `null` when they have none. */
export async function storedSession(): Promise<StoredSession | null> {
  const [row] = await database(testEnv)
    .select()
    .from(nowPlaying)
    .where(eq(nowPlaying.userId, await adminId()));

  return row ?? null;
}

/** Forgets the admin's session, so a test starts from nothing playing. */
export async function clearSession(): Promise<void> {
  await database(testEnv)
    .delete(nowPlaying)
    .where(eq(nowPlaying.userId, await adminId()));
}

/**
 * Puts the admin's session in place as it would stand after a report made
 * at `reportedAt` — which a test cannot make through the endpoint, since the
 * endpoint stamps a report with the server's now.
 */
export async function seedSession(
  session: Partial<StoredSession> & { readonly trackId: string },
): Promise<void> {
  const now = Date.now();
  const row = {
    playerName: "Substreamer",
    state: "playing",
    positionMs: 0,
    playbackRate: 1,
    startedAt: new Date(now),
    reportedAt: new Date(now),
    expiresAt: new Date(now + 60 * 60_000),
    ...session,
    userId: await adminId(),
  };

  await clearSession();
  await database(testEnv).insert(nowPlaying).values(row);
}

/** What one request cost D1: the statements it ran and the rows they wrote. */
export interface CountedRequest {
  readonly body: WriteResponse;
  /** The statements against the session and the annotations, in order. */
  readonly statements: readonly RecordedWrite[];
  /** The rows those statements wrote, index rows included. */
  readonly rowsWritten: number;
  /** The subrequests they took: one per lone statement, one per batch. */
  readonly subrequests: number;
}

/**
 * Calls an endpoint through the Worker's own `fetch` handler, against a D1
 * that records every statement — the handler `SELF.fetch` reaches, with the
 * counting `recordingDatabase` in front of the real storage.
 *
 * Only the statements that read or write `now_playing` or `annotation` are
 * kept: authentication reads the user on every request, and that cost is
 * every endpoint's, not this one's.
 */
export async function callCounting(
  endpoint: string,
  params: Record<string, string>,
): Promise<CountedRequest> {
  const writes: RecordedWrite[] = [];
  const env: Env = { ...testEnv, DB: recordingDatabase(writes) };
  const request = new Request(
    `${BASE}/rest/${endpoint}?${writeQuery({ ...params, f: "json" })}`,
  ) as Parameters<NonNullable<typeof worker.fetch>>[0];
  const handler = worker.fetch as NonNullable<typeof worker.fetch>;
  const response = await handler(request, env, createExecutionContext());
  const body = ((await response.json()) as { "subsonic-response": WriteResponse })[
    "subsonic-response"
  ];

  const statements = writes.filter((write) => /"now_playing"|"annotation"/.test(write.sql));
  const batches = new Set(statements.map((write) => write.batch).filter((batch) => batch !== null));

  return {
    body,
    statements,
    rowsWritten: statements.reduce((total, write) => total + write.rowsWritten, 0),
    subrequests: statements.filter((write) => write.batch === null).length + batches.size,
  };
}
