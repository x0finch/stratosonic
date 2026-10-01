import {
  annotation,
  bookmark,
  nowPlaying,
  playlist,
  playlistTrack,
  playQueue,
  subsonicUser,
} from "@stratosonic/db";
import { asc } from "drizzle-orm";
import { expect } from "vitest";
import { createApp } from "../src/app";
import { database } from "../src/db";
import type { Env } from "../src/env";
import {
  type CookieJar,
  consoleRequest,
  cost,
  countingD1,
  type RecordedStatement,
} from "./console-auth-support";
import { testEnv } from "./support";

/**
 * The console's Subsonic-user routes under test (#82, #115): the Worker's app
 * over a D1 binding that records every statement, and an R2 binding that
 * records every `delete` and can be made to fail one.
 */

/** A Subsonic user as the console API answers with one. */
export interface SubsonicUserView {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
  updatedAt: string;
  lastAccessAt: string | null;
}

export interface SubsonicUsersHarness {
  readonly send: (request: Request) => Response | Promise<Response>;
  readonly d1: ReturnType<typeof countingD1>;
  /** Every `MUSIC.delete` call, with the keys it was given. */
  readonly r2Deletes: (string | string[])[];
  /** Makes the next `MUSIC.delete` throw, as an R2 outage would, before it deletes anything. */
  failNextR2Delete(): void;
  /**
   * Runs `step` right after the next `MUSIC.delete`, before the request goes
   * on: another request's write landing in between, as in a race.
   */
  afterNextR2Delete(step: () => Promise<unknown>): void;
  /** Makes the next D1 batch holding a delete of a Subsonic user throw, as a D1 outage would. */
  failNextUserDeleteBatch(): void;
  /** Calls a route as the console would, signed in with `jar`. */
  call(
    jar: CookieJar | undefined,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
}

export function subsonicUsersHarness(origin: string): SubsonicUsersHarness {
  const r2Deletes: (string | string[])[] = [];
  let failR2 = false;
  let failBatch = false;
  let afterR2: (() => Promise<unknown>) | null = null;

  const music = new Proxy(testEnv.MUSIC, {
    get(target, property) {
      if (property === "delete") {
        return async (keys: string | string[]) => {
          r2Deletes.push(keys);
          if (failR2) {
            failR2 = false;
            throw new Error("R2 is unavailable");
          }
          await target.delete(keys);
          const step = afterR2;
          afterR2 = null;
          await step?.();
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const counted = countingD1(testEnv.DB);
  const db = new Proxy(counted.binding, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const sql = statements.map((statement) => (statement as unknown as { sql: string }).sql);
          if (failBatch && sql.some((text) => /^delete from "subsonic_user"/.test(text))) {
            failBatch = false;
            throw new Error("D1 is unavailable");
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const env: Env = { ...testEnv, DB: db, MUSIC: music };
  const app = createApp();
  const send = (request: Request) => app.request(request, undefined, env);

  return {
    send,
    d1: counted,
    r2Deletes,
    failNextR2Delete: () => {
      failR2 = true;
    },
    afterNextR2Delete: (step) => {
      afterR2 = step;
    },
    failNextUserDeleteBatch: () => {
      failBatch = true;
    },
    call: async (jar, method, path, body, headers = {}) => {
      const request = consoleRequest(origin, `/api${path}`, { method, body, jar });
      // After the helper's own, so a test can replace its `Content-Type`.
      for (const [name, value] of Object.entries(headers)) {
        request.headers.set(name, value);
      }
      return send(request);
    },
  };
}

/** Every row a Subsonic-user write could change, in a stable order. */
export async function snapshot() {
  const db = database(testEnv);
  return {
    users: await db.select().from(subsonicUser).orderBy(asc(subsonicUser.id)),
    playlists: await db.select().from(playlist).orderBy(asc(playlist.id)),
    entries: await db
      .select()
      .from(playlistTrack)
      .orderBy(asc(playlistTrack.playlistId), asc(playlistTrack.position)),
    annotations: await db
      .select()
      .from(annotation)
      .orderBy(asc(annotation.userId), asc(annotation.itemId)),
    nowPlaying: await db.select().from(nowPlaying).orderBy(asc(nowPlaying.userId)),
    playQueues: await db.select().from(playQueue).orderBy(asc(playQueue.userId)),
    bookmarks: await db
      .select()
      .from(bookmark)
      .orderBy(asc(bookmark.userId), asc(bookmark.trackId)),
  };
}

/** Runs `action` and answers the statements it sent to D1. */
export async function measured(
  harness: SubsonicUsersHarness,
  action: () => unknown,
): Promise<RecordedStatement[]> {
  harness.d1.reset();
  await action();
  return [...harness.d1.statements];
}

/**
 * That a request is refused with this status and error, and writes nothing:
 * no D1 row and no R2 delete.
 */
export async function expectRefusal(
  harness: SubsonicUsersHarness,
  request: () => Response | Promise<Response>,
  status: number,
  error: string,
): Promise<void> {
  const before = await snapshot();
  const deletes = harness.r2Deletes.length;
  let response: Response | undefined;
  const statements = await measured(harness, async () => {
    response = await request();
  });

  expect(response?.status).toBe(status);
  expect(await response?.json()).toEqual({ error });
  expect(cost(statements).rowsWritten).toBe(0);
  expect(harness.r2Deletes.length).toBe(deletes);
  expect(await snapshot()).toEqual(before);
}
