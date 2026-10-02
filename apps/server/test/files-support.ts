import { playlist, playlistTrack, property, track } from "@stratosonic/db";
import { asc } from "drizzle-orm";
import { expect } from "vitest";
import { createApp } from "../src/app";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { type CookieJar, consoleRequest, cost, countingD1 } from "./console-auth-support";
import { driverIsIdle } from "./driver-support";
import { testEnv } from "./support";

/**
 * The Files API under test (#83, #131): the Worker's app over a D1 binding
 * that records every statement, an R2 binding that records every call it is
 * asked for and can be given a smaller listing page, and a scan driver
 * binding that records every call it is asked for.
 */

/** One call to the bucket's binding: its method and first argument. */
export interface R2Call {
  readonly method: string;
  readonly argument: unknown;
}

export interface FilesHarnessOptions {
  /** Caps every listing's `limit`, as a smaller R2 page would. */
  readonly listLimit?: number;
  /** Replaces the scan driver's binding, to make it fail. */
  readonly scanDriver?: Env["SCAN_DRIVER"];
  /** `FILE_WRITES`, unset (writes on) unless given. */
  readonly fileWrites?: string;
  /** Makes every write of a `property` row fail, as a D1 outage would. */
  readonly failPropertyWrite?: boolean;
}

export interface FilesHarness {
  readonly send: (request: Request) => Response | Promise<Response>;
  readonly d1: ReturnType<typeof countingD1>;
  /** Every call to `MUSIC` the app made, in order. */
  readonly r2Calls: R2Call[];
  /** Every method called on the scan driver's stub, in order. */
  readonly driverCalls: string[];
  /** Calls a route as the console would, signed in with `jar`. */
  call(
    jar: CookieJar | undefined,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
}

export function filesHarness(origin: string, options: FilesHarnessOptions = {}): FilesHarness {
  const r2Calls: R2Call[] = [];
  const driverCalls: string[] = [];

  const music = new Proxy(testEnv.MUSIC, {
    get(target, name) {
      const value = Reflect.get(target, name);
      if (typeof value !== "function") {
        return value;
      }
      return (argument: unknown, ...rest: unknown[]) => {
        r2Calls.push({ method: String(name), argument });
        if (name === "list" && options.listLimit !== undefined) {
          const listing = (argument ?? {}) as R2ListOptions;
          return target.list({
            ...listing,
            limit: Math.min(listing.limit ?? 1000, options.listLimit),
          });
        }
        return (value as (...args: unknown[]) => unknown).apply(target, [argument, ...rest]);
      };
    },
  });

  const namespace = options.scanDriver ?? testEnv.SCAN_DRIVER;
  const scanDriver = new Proxy(namespace, {
    get(target, name) {
      if (name === "get") {
        return (id: DurableObjectId) => {
          const stub = target.get(id);
          return new Proxy(stub, {
            get(inner, method) {
              const value = Reflect.get(inner, method);
              if (typeof value !== "function") {
                return value;
              }
              return (...args: unknown[]) => {
                driverCalls.push(String(method));
                return (inner as unknown as Record<string, (...a: unknown[]) => unknown>)[
                  String(method)
                ]?.(...args);
              };
            },
          });
        };
      }
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const d1 = countingD1(testEnv.DB);
  const db = new Proxy(d1.binding, {
    get(target, name) {
      if (name === "prepare" && options.failPropertyWrite) {
        return (sql: string) => {
          if (!/^insert into "property"/.test(sql)) {
            return target.prepare(sql);
          }
          const failing = {
            bind: () => failing,
            run: () => Promise.reject(new Error("D1 is unavailable")),
            all: () => Promise.reject(new Error("D1 is unavailable")),
            raw: () => Promise.reject(new Error("D1 is unavailable")),
            first: () => Promise.reject(new Error("D1 is unavailable")),
          };
          return failing;
        };
      }
      const value = Reflect.get(target, name);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const env: Env = {
    ...testEnv,
    DB: db,
    MUSIC: music,
    SCAN_DRIVER: scanDriver,
    FILE_WRITES: options.fileWrites ?? "",
  };
  const app = createApp();
  const send = (request: Request) => app.request(request, undefined, env);

  return {
    send,
    d1,
    r2Calls,
    driverCalls,
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

/** Every key in the bucket, sorted, past R2's 1,000-a-page listing. */
export async function allKeys(prefix?: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listing = await testEnv.MUSIC.list({ prefix, cursor });
    keys.push(...listing.objects.map((object) => object.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);

  return keys.sort();
}

/** Puts each key in the bucket with a few bytes of its own, `concurrency` at a time. */
export async function seedObjects(keys: readonly string[], concurrency = 50): Promise<void> {
  for (let start = 0; start < keys.length; start += concurrency) {
    await Promise.all(
      keys
        .slice(start, start + concurrency)
        .map((key) => testEnv.MUSIC.put(key, `bytes of ${key}`)),
    );
  }
}

/** Every row a file write could change, in a stable order. */
export async function rows() {
  const db = database(testEnv);
  return {
    tracks: await db.select().from(track).orderBy(asc(track.id)),
    playlists: await db.select().from(playlist).orderBy(asc(playlist.id)),
    entries: await db
      .select()
      .from(playlistTrack)
      .orderBy(asc(playlistTrack.playlistId), asc(playlistTrack.position)),
    properties: await db.select().from(property).orderBy(asc(property.id)),
  };
}

/**
 * That a request is refused with this status and error, and changes nothing:
 * no object, no D1 row written, and no call to the scan driver, which stays
 * idle.
 */
export async function expectRefusal(
  harness: FilesHarness,
  request: () => Response | Promise<Response>,
  status: number,
  error: string,
): Promise<void> {
  const keysBefore = await allKeys();
  const rowsBefore = await rows();
  const r2Writes = harness.r2Calls.filter((call) => call.method !== "list").length;
  const driverCalls = harness.driverCalls.length;
  harness.d1.reset();

  const response = await request();

  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
  expect(cost(harness.d1.statements).rowsWritten).toBe(0);
  expect(harness.r2Calls.filter((call) => call.method !== "list").length).toBe(r2Writes);
  expect(harness.driverCalls.length).toBe(driverCalls);
  expect(await allKeys()).toEqual(keysBefore);
  expect(await rows()).toEqual(rowsBefore);
  expect(await driverIsIdle()).toBe(true);
}
