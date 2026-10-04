import { library, property } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { nextUtcMidnight, SCAN_ROWS_WRITTEN_KEY, utcDay } from "../src/scanner/budget";
import { noCounts } from "../src/scanner/state";
import { bootstrapAdmin } from "./browsing-support";
import {
  type CookieJar,
  consoleRequest,
  countingD1,
  seedConsoleUser,
  shape,
  signIn,
} from "./console-auth-support";
import { SEED_TIME, testEnv } from "./support";

/**
 * The scan across libraries in `GET /api/overview/live` (#84, "Console"):
 * `scan.library` says which library the scan phase is in (`{id, name,
 * index, of}` among the active libraries: "Scanning Archive (2 of 3)."),
 * and `scan.paused` says the daily write budget has stopped every pass until
 * the next 00:00 UTC. Both are read from D1, in the route's one round trip,
 * with no Durable Object request.
 */

const ORIGIN = "https://overview-live-libraries.stratosonic.test";
const d1 = countingD1(testEnv.DB);
let driverRequests = 0;
const env = {
  ...testEnv,
  DB: d1.binding,
  SCAN_DRIVER: {
    idFromName: (name: string) => testEnv.SCAN_DRIVER.idFromName(name),
    get: () => {
      driverRequests++;
      throw new Error("the live view must not reach the scan driver");
    },
  },
} as unknown as Env;
const app = createApp();
const send = (request: Request) => app.request(request, undefined, env);

let owner: CookieJar;

interface LiveScan {
  running: boolean;
  phase: string | null;
  library: { id: number; name: string; index: number; of: number } | null;
  paused: { reason: string; until: string } | null;
}

async function liveScan(): Promise<LiveScan> {
  d1.reset();
  driverRequests = 0;
  const response = await send(consoleRequest(ORIGIN, "/api/overview/live", { jar: owner }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { scan: LiveScan }).scan;
}

/** A pass in flight, as its row says, in `libraryId`. */
async function passIn(libraryId: number): Promise<void> {
  await database(testEnv)
    .insert(property)
    .values({
      id: "ScanProgress",
      value: JSON.stringify({
        startedAt: SEED_TIME.getTime(),
        libraryId,
        cursor: "c",
        skip: 0,
        sweptTo: "",
        counts: noCounts(),
      }),
    })
    .onConflictDoUpdate({
      target: property.id,
      set: {
        value: JSON.stringify({
          startedAt: SEED_TIME.getTime(),
          libraryId,
          cursor: "c",
          skip: 0,
          sweptTo: "",
          counts: noCounts(),
        }),
      },
    });
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedConsoleUser("Owner", "overview");
  owner = (await signIn(send, ORIGIN, "owner", "overview")).jar;
  const db = database(testEnv);
  for (const [id, name, state] of [
    [2, "Archive", "active"],
    [3, "Gone", "removing"],
    [4, "Vinyl", "active"],
  ] as const) {
    await db.insert(library).values({
      id,
      name,
      path: `s3://acct${id}.r2.cloudflarestorage.com/b${id}`,
      kind: "s3",
      state,
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
    });
  }
});

afterEach(async () => {
  await database(testEnv).delete(property);
});

describe("scan.library", () => {
  it("is null with no pass in flight", async () => {
    expect((await liveScan()).library).toBeNull();
  });

  it("names the library the pass is in, and its place among the active ones", async () => {
    await passIn(2);
    expect((await liveScan()).library).toEqual({ id: 2, name: "Archive", index: 2, of: 3 });

    await passIn(1);
    expect((await liveScan()).library).toEqual({
      id: 1,
      name: "Music Library",
      index: 1,
      of: 3,
    });
  });

  it("skips a library being removed, as the scan does", async () => {
    await passIn(3);
    expect((await liveScan()).library).toEqual({ id: 4, name: "Vinyl", index: 3, of: 3 });
  });

  it("is null once every library has been listed", async () => {
    await passIn(5);
    expect((await liveScan()).library).toBeNull();
  });

  it("is read in the route's one round trip, with no Durable Object request", async () => {
    await passIn(2);
    await liveScan();
    expect(new Set(d1.statements.map((statement) => statement.roundTrip)).size).toBe(1);
    expect(d1.statements.map(shape)).toContain("select library");
    expect(driverRequests).toBe(0);
  });
});

describe("scan.paused", () => {
  it("is null under the day's budget", async () => {
    await database(testEnv)
      .insert(property)
      .values({
        id: SCAN_ROWS_WRITTEN_KEY,
        value: JSON.stringify({ day: utcDay(Date.now()), rows: 49_999 }),
      });
    expect((await liveScan()).paused).toBeNull();
  });

  it("is null for another day's tally", async () => {
    await database(testEnv)
      .insert(property)
      .values({
        id: SCAN_ROWS_WRITTEN_KEY,
        value: JSON.stringify({ day: "2000-01-01", rows: 1_000_000 }),
      });
    expect((await liveScan()).paused).toBeNull();
  });

  it("says until when once the day's budget is spent, and the pass is not running", async () => {
    await passIn(2);
    const now = Date.now();
    await database(testEnv)
      .insert(property)
      .values({
        id: SCAN_ROWS_WRITTEN_KEY,
        value: JSON.stringify({ day: utcDay(now), rows: 50_000 }),
      });

    const scan = await liveScan();
    expect(scan.paused).toEqual({
      reason: "daily_write_budget",
      until: new Date(nextUtcMidnight(now)).toISOString(),
    });
    expect(scan.running).toBe(false);
    expect(scan.library).toBeNull();
    expect(driverRequests).toBe(0);
  });

  it("is never set with no cap", async () => {
    await database(testEnv)
      .insert(property)
      .values({
        id: SCAN_ROWS_WRITTEN_KEY,
        value: JSON.stringify({ day: utcDay(Date.now()), rows: 10_000_000 }),
      });
    const uncapped = { ...env, SCAN_DAILY_WRITE_BUDGET: "0" } as Env;
    const response = await app.request(
      consoleRequest(ORIGIN, "/api/overview/live", { jar: owner }),
      undefined,
      uncapped,
    );
    expect(((await response.json()) as { scan: LiveScan }).scan.paused).toBeNull();
  });
});

describe("a library row that changes name", () => {
  it("is read fresh on every poll", async () => {
    await passIn(2);
    await database(testEnv).update(library).set({ name: "Old Archive" }).where(eq(library.id, 2));
    expect((await liveScan()).library?.name).toBe("Old Archive");
    await database(testEnv).update(library).set({ name: "Archive" }).where(eq(library.id, 2));
  });
});
