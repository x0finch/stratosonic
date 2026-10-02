import { runInDurableObject } from "cloudflare:test";
import { playlist, playlistTrack, property, track } from "@stratosonic/db";
import { asc } from "drizzle-orm";
import { expect } from "vitest";
import { createApp } from "../src/app";
import { database } from "../src/db";
import type { Env } from "../src/env";
import type { ScanDriver } from "../src/scanner/driver";
import { type CookieJar, consoleRequest, cost, countingD1 } from "./console-auth-support";
import { driver, driverIsIdle } from "./driver-support";
import { testEnv } from "./support";

/**
 * The Files API under test (#83, #131, #132): the Worker's app over a D1
 * binding that records every statement, an R2 binding that records every call
 * it is asked for (and how many were in flight at once) and can be given a
 * smaller listing page, and a scan driver binding that records every call it
 * is asked for.
 *
 * The R2 binding's `head()` treats Unicode-equivalent keys as one object, as
 * R2 does ("Unicode interoperability") and miniflare's simulation does not:
 * a key stored in NFD is found by its NFC spelling, and answered with the
 * stored one.
 */

/**
 * A complete, made-up upload configuration: the token's two values, the
 * account id and the bucket's name. Nothing signed with it reaches R2.
 */
export const UPLOADS_ENV = {
  R2_ACCESS_KEY_ID: "test-access-key-id",
  R2_SECRET_ACCESS_KEY: "test-secret-access-key-not-real",
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET_NAME: "navidrome",
} as const;

/** One call to the bucket's binding: its method and first argument. */
export interface R2Call {
  readonly method: string;
  readonly argument: unknown;
}

export interface FilesHarnessOptions {
  /** Caps every listing's `limit`, as a smaller R2 page would. */
  readonly listLimit?: number;
  /**
   * The scan driver binding: `inertDriver()` unless given, so no test starts
   * a pass or arms a debounce alarm by accident. `"real"` is the pool's own
   * Durable Object, for the tests about what the driver does; they leave it
   * to `resetDriver`.
   */
  readonly scanDriver?: Env["SCAN_DRIVER"] | "real";
  /** `FILE_WRITES`: `""` (unset, writes on) unless given; `undefined` leaves it out. */
  readonly fileWrites?: string;
  /** Makes every write of a `property` row fail, as a D1 outage would. */
  readonly failPropertyWrite?: boolean;
  /**
   * The upload settings, over the pinned ones (where the token is unset):
   * `UPLOADS_ENV` configures uploads.
   */
  readonly uploads?: Partial<Pick<Env, keyof typeof UPLOADS_ENV>>;
  /** Makes the `MUSIC.delete` call of this number (from 1) throw before it deletes anything. */
  readonly failDeleteCall?: number;
  /** Makes a listing given this cursor throw, as R2 refuses a cursor it never issued. */
  readonly refusedCursor?: string;
  /** Makes every listing throw, as an R2 outage would. */
  readonly failListing?: boolean;
  /**
   * Makes `head()` answer an object found under another Unicode spelling
   * with the key it was asked for, rather than the stored one. R2 does not
   * document which it answers; Replace must keep the stored spelling either
   * way.
   */
  readonly headAnswersAskedKey?: boolean;
}

/**
 * A scan driver binding that answers every call at once and does nothing:
 * no pass starts and no debounce alarm is armed, so nothing runs in the
 * background of a test that only needs the call to succeed. `touch`, the one
 * call the routes make, answers a schedule; `start` answers "started".
 */
export function inertDriver(): Env["SCAN_DRIVER"] {
  return {
    idFromName: (name: string) => testEnv.SCAN_DRIVER.idFromName(name),
    get: () =>
      new Proxy(
        {},
        {
          get: (_, method) => async () =>
            method === "start"
              ? "started"
              : { scheduledAt: new Date().toISOString(), afterCurrentPass: false },
        },
      ),
  } as unknown as Env["SCAN_DRIVER"];
}

/**
 * Empties the real scan driver: its alarm and its storage, a pass's state or
 * a pending change alike. A test that let the real driver be told about a
 * change ends with this rather than with `driveUntilIdle`, which cannot
 * reach idle while a debounced pass waits out its quiet window.
 */
export async function resetDriver(): Promise<void> {
  await runInDurableObject(driver(), async (_instance: ScanDriver, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
  });
}

/** A scan driver binding whose every call fails, as an unreachable Durable Object would. */
export function unreachableDriver(): Env["SCAN_DRIVER"] {
  return {
    idFromName: (name: string) => testEnv.SCAN_DRIVER.idFromName(name),
    get: () =>
      new Proxy(
        {},
        { get: () => () => Promise.reject(new Error("the scan driver is unreachable")) },
      ),
  } as unknown as Env["SCAN_DRIVER"];
}

export interface FilesHarness {
  readonly send: (request: Request) => Response | Promise<Response>;
  readonly d1: ReturnType<typeof countingD1>;
  /** Every call to `MUSIC` the app made, in order. */
  readonly r2Calls: R2Call[];
  /** The most calls to `MUSIC` in flight at once, since the last reset. */
  readonly r2Peak: { inFlight: number; peak: number };
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
  const r2Peak = { inFlight: 0, peak: 0 };
  const driverCalls: string[] = [];
  let deleteCalls = 0;

  const music = new Proxy(testEnv.MUSIC, {
    get(target, name) {
      const value = Reflect.get(target, name);
      if (typeof value !== "function") {
        return value;
      }
      return async (argument: unknown, ...rest: unknown[]) => {
        r2Calls.push({ method: String(name), argument });
        r2Peak.inFlight++;
        r2Peak.peak = Math.max(r2Peak.peak, r2Peak.inFlight);
        try {
          if (name === "delete" && ++deleteCalls === options.failDeleteCall) {
            throw new Error("R2 is unavailable");
          }
          if (name === "list") {
            const listing = (argument ?? {}) as R2ListOptions;
            if (options.failListing) {
              throw new Error("R2 is unavailable");
            }
            if (options.refusedCursor !== undefined && listing.cursor === options.refusedCursor) {
              throw new Error("list: the cursor is not valid");
            }
            if (options.listLimit !== undefined) {
              return await target.list({
                ...listing,
                limit: Math.min(listing.limit ?? 1000, options.listLimit),
              });
            }
          }
          if (name === "head" && typeof argument === "string") {
            const object = await headAnySpelling(target, argument);
            return object !== null && options.headAnswersAskedKey
              ? withKey(object, argument)
              : object;
          }
          return await (value as (...args: unknown[]) => unknown).apply(target, [
            argument,
            ...rest,
          ]);
        } finally {
          r2Peak.inFlight--;
        }
      };
    },
  });

  const namespace =
    options.scanDriver === "real" ? testEnv.SCAN_DRIVER : (options.scanDriver ?? inertDriver());
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
    // Given, even as undefined, or else unset as the pinned env has it.
    FILE_WRITES: "fileWrites" in options ? options.fileWrites : "",
    ...options.uploads,
  };
  const app = createApp();
  const send = (request: Request) => app.request(request, undefined, env);

  return {
    send,
    d1,
    r2Calls,
    r2Peak,
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

/**
 * `head()` as R2 answers it: the object under the key, or else under any
 * spelling NFC-equal to it (composed, decomposed or mixed), with the key it
 * is stored under. The other spellings are found by listing the whole
 * bucket, which a test's bucket keeps small.
 */
async function headAnySpelling(bucket: R2Bucket, key: string): Promise<R2Object | null> {
  const exact = await bucket.head(key);
  if (exact !== null) {
    return exact;
  }

  const nfc = key.normalize("NFC");
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ cursor });
    const match = listing.objects.find((object) => object.key.normalize("NFC") === nfc);
    if (match !== undefined) {
      return bucket.head(match.key);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);

  return null;
}

/** The object as `head()` found it, but answering `key` as its key. */
function withKey(object: R2Object, key: string): R2Object {
  return new Proxy(object, {
    get: (target, name) => (name === "key" ? key : Reflect.get(target, name)),
  });
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
