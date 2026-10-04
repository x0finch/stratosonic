import { SELF } from "cloudflare:test";
import { property } from "@stratosonic/db";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_JSON_BODY_BYTES } from "../src/api/json-body";
import { createApp } from "../src/app";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { readLastScanSummary, readScanProgress, type ScanSummary } from "../src/scanner/state";
import {
  type CookieJar,
  consoleRequest,
  cost,
  countingD1,
  GUEST_ROLE,
  seedConsoleUser,
  shape,
  signIn,
} from "./console-auth-support";
import { driverIsIdle, driveUntilIdle, poke, runNextAlarm, slowTuning } from "./driver-support";
import { fixtures } from "./fixtures/files";
import { resetLibrary, seedFixtureFiles } from "./scan-support";
import { BASE, testEnv } from "./support";

/**
 * The scan as the console's Overview sees it (#82, "API: overview"): the
 * `scan` of `GET /api/overview/live` in each state a pass can be in, which
 * must agree with what `getScanStatus` says in the same state, and
 * `POST /api/library/scan`, the console's **Scan now**, which pokes the
 * driver as `startScan` does.
 *
 * The scan behind both is the real one, driven as test/scan-status.test.ts
 * drives it: the Durable Object the binding creates, with its alarms fired by
 * the test.
 */

const ORIGIN = "https://overview-scan.stratosonic.test";
const d1 = countingD1(testEnv.DB);
const env: Env = { ...testEnv, DB: d1.binding };
const app = createApp();
const send = (request: Request, onEnv: Env = env) => app.request(request, undefined, onEnv);

/** The instant the in-flight pass in this file is stamped with. */
const IN_FLIGHT_POKE = new Date(1_760_000_000_000);

/** And the one whose playlist import is caught half done. */
const IMPORT_POKE = new Date(IN_FLIGHT_POKE.getTime() + 15 * 60_000);

interface ConsoleScan {
  running: boolean;
  phase: "scan" | "playlists" | null;
  progress: {
    startedAt: string;
    tracks: number;
    examined: number;
    added: number;
    updated: number;
    removed: number;
  } | null;
  estimatedTotal: number | null;
  last: {
    startedAt: string;
    finishedAt: string;
    steps: number;
    counts: Record<string, number>;
  } | null;
  scheduled: unknown;
}

interface ScanStatusElement {
  scanning: boolean;
  count: number;
  lastScan?: string;
}

let owner: CookieJar;
let guest: CookieJar;

beforeAll(async () => {
  // The bootstrap admin `getScanStatus` is asked as.
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedConsoleUser("Owner", "overview");
  await seedConsoleUser("Guest", "nothing", GUEST_ROLE);
  owner = (await signIn(send, ORIGIN, "owner", "overview")).jar;
  guest = (await signIn(send, ORIGIN, "guest", "nothing")).jar;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function consoleScan(): Promise<ConsoleScan> {
  const response = await send(consoleRequest(ORIGIN, "/api/overview/live", { jar: owner }));
  expect(response.status).toBe(200);
  return ((await response.json()) as { scan: ConsoleScan }).scan;
}

async function scanStatus(): Promise<ScanStatusElement> {
  const query = new URLSearchParams({ u: "admin", p: "sesame", v: "1.16.1", c: "test", f: "json" });
  const response = await SELF.fetch(`${BASE}/rest/getScanStatus?${query}`);
  const body = (await response.json()) as {
    "subsonic-response": { scanStatus: ScanStatusElement };
  };
  return body["subsonic-response"].scanStatus;
}

/** `POST /api/library/scan`, as the console sends it unless told otherwise. */
function requestScan(
  init: { jar?: CookieJar; body?: unknown; headers?: Record<string, string> } = {},
  onEnv: Env = env,
) {
  return send(
    consoleRequest(ORIGIN, "/api/library/scan", {
      method: "POST",
      jar: "jar" in init ? init.jar : owner,
      body: "body" in init ? init.body : {},
      headers: init.headers,
    }),
    onEnv,
  );
}

function tracksOf(summary: ScanSummary | null): number {
  return summary === null ? 0 : summary.counts.indexed + summary.counts.unchanged;
}

/** `last`, as the console carries the summary. */
function lastOf(summary: ScanSummary) {
  const { steps, ...counts } = summary.counts;
  return {
    startedAt: new Date(summary.startedAt).toISOString(),
    finishedAt: new Date(summary.finishedAt).toISOString(),
    steps,
    counts,
  };
}

/* ============================================================ the states == */

describe("the scan before any pass", () => {
  it("is idle with nothing to report, as getScanStatus says", async () => {
    expect(await consoleScan()).toEqual({
      running: false,
      phase: null,
      progress: null,
      library: null,
      paused: null,
      estimatedTotal: null,
      last: null,
      scheduled: null,
    });
    expect(await scanStatus()).toEqual({ scanning: false, count: 0 });
  });
});

describe("the scan in flight, then completed", () => {
  let during: ConsoleScan;
  let duringStatus: ScanStatusElement;

  beforeAll(async () => {
    await resetLibrary();
    await seedFixtureFiles();

    // One track a step, with alarms only the test fires, so the pass is
    // still going after the first.
    await poke(IN_FLIGHT_POKE, { ...slowTuning, scanLimits: { extractionsPerRun: 1 } });
    await runNextAlarm();

    during = await consoleScan();
    duringStatus = await scanStatus();
  });

  it("is running its scan phase, with the tracks getScanStatus counts", async () => {
    const progress = await readScanProgress(database(testEnv));

    expect(duringStatus.scanning).toBe(true);
    expect(during).toMatchObject({ running: true, phase: "scan" });
    expect(during.progress).toEqual({
      startedAt: IN_FLIGHT_POKE.toISOString(),
      tracks: duringStatus.count,
      examined: progress?.counts.examined,
      added: progress?.counts.added,
      updated: progress?.counts.updated,
      removed: progress?.counts.removed,
    });
    expect(during.progress?.tracks).toBeGreaterThan(0);
    expect(during.progress?.tracks).toBeLessThan(fixtures.tracks.length);
  });

  it("has no estimate before the first pass completes", () => {
    expect(during.estimatedTotal).toBeNull();
    expect(during.last).toBeNull();
  });

  it("is idle once the pass completes, with its summary and track count", async () => {
    await driveUntilIdle();
    const summary = await readLastScanSummary(database(testEnv));
    const status = await scanStatus();
    if (summary === null) {
      throw new Error("the pass left no summary");
    }

    expect(status.scanning).toBe(false);
    expect(await consoleScan()).toEqual({
      running: false,
      phase: null,
      progress: null,
      library: null,
      paused: null,
      estimatedTotal: status.count,
      last: lastOf(summary),
      scheduled: null,
    });
    expect(status.count).toBe(fixtures.tracks.length);
    expect(status.lastScan).toBe(new Date(summary.finishedAt).toISOString());
  });
});

describe("the scan in its playlist-import phase", () => {
  let during: ConsoleScan;
  let duringStatus: ScanStatusElement;

  beforeAll(async () => {
    // One object a step for the import, so it takes several alarms.
    await poke(IMPORT_POKE, { ...slowTuning, playlistLimits: { objectsPerRun: 1 } });

    // Until this pass's scan half has written its summary, then the import's
    // first step, which writes the row this phase is known by.
    for (let step = 0; step < 20; step++) {
      if ((await readLastScanSummary(database(testEnv)))?.startedAt === IMPORT_POKE.getTime()) {
        break;
      }
      await runNextAlarm();
    }
    await runNextAlarm();

    during = await consoleScan();
    duringStatus = await scanStatus();
  });

  it("is still running, as getScanStatus says, with no scan progress", async () => {
    expect(await readScanProgress(database(testEnv))).toBeNull();
    expect(duringStatus.scanning).toBe(true);
    expect(during).toMatchObject({ running: true, phase: "playlists", progress: null });
  });

  it("estimates with the count getScanStatus reports, this pass's scan half", async () => {
    const summary = await readLastScanSummary(database(testEnv));

    expect(during.estimatedTotal).toBe(duringStatus.count);
    expect(during.estimatedTotal).toBe(tracksOf(summary));
    expect(during.last?.startedAt).toBe(IMPORT_POKE.toISOString());
  });

  it("is idle once the import is over too", async () => {
    await driveUntilIdle();

    expect(await scanStatus()).toMatchObject({ scanning: false, count: fixtures.tracks.length });
    expect(await consoleScan()).toMatchObject({
      running: false,
      phase: null,
      estimatedTotal: fixtures.tracks.length,
    });
  });
});

/* ================================================ POST /api/library/scan == */

describe("POST /api/library/scan, refused", () => {
  async function expectRefusal(
    request: () => Response | Promise<Response>,
    status: number,
    error: string,
  ): Promise<void> {
    const before = await database(testEnv).select().from(property);
    d1.reset();

    const response = await request();

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(cost(d1.statements).rowsWritten).toBe(0);
    expect(await database(testEnv).select().from(property)).toEqual(before);
    expect(await driverIsIdle()).toBe(true);
  }

  it("answers 401 without a session", async () => {
    await expectRefusal(() => requestScan({ jar: undefined }), 401, "unauthenticated");
  });

  it("answers 403 to a role without library:scan", async () => {
    await expectRefusal(() => requestScan({ jar: guest }), 403, "forbidden");
  });

  it("answers 403 forbidden_origin to a cross-origin request", async () => {
    await expectRefusal(
      () => requestScan({ headers: { origin: "https://elsewhere.test" } }),
      403,
      "forbidden_origin",
    );
  });

  it("answers 403 forbidden_origin to a body that is not JSON", async () => {
    await expectRefusal(
      () =>
        send(
          new Request(`${ORIGIN}/api/library/scan`, {
            method: "POST",
            headers: { origin: ORIGIN, cookie: owner.header(), "content-type": "text/plain" },
            body: "{}",
          }),
        ),
      403,
      "forbidden_origin",
    );
  });

  it("answers 413 to a body over the cap", async () => {
    await expectRefusal(
      () => requestScan({ body: { padding: "x".repeat(MAX_JSON_BODY_BYTES) } }),
      413,
      "payload_too_large",
    );
  });

  it("answers 400 to a body that is not a JSON object", async () => {
    await expectRefusal(() => requestScan({ body: [] }), 400, "invalid_request");
  });

  it("answers 500 internal when the poke fails, as the console's error toast expects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      ...env,
      SCAN_DRIVER: {
        idFromName: (name: string) => testEnv.SCAN_DRIVER.idFromName(name),
        get: () => ({
          start: () => Promise.reject(new Error("the driver is unreachable")),
        }),
      },
    } as unknown as Env;

    await expectRefusal(() => requestScan({}, failing), 500, "internal");
  });
});

describe("POST /api/library/scan", () => {
  let first: Response;
  let firstCost: ReturnType<typeof cost>;
  let firstShapes: string[];
  let idleRightAfter = true;
  let second: Response;

  beforeAll(async () => {
    d1.reset();
    first = await requestScan();
    firstCost = cost(d1.statements);
    firstShapes = d1.statements.map(shape);
    idleRightAfter = await driverIsIdle();
    second = await requestScan();
  });

  it("starts a pass and answers that a scan is running", async () => {
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "started", scan: { running: true } });
  });

  it("arms the driver, which then carries the pass to completion", async () => {
    expect(idleRightAfter).toBe(false);

    await driveUntilIdle();

    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.startedAt).toBeGreaterThan(IMPORT_POKE.getTime());
    expect(await consoleScan()).toMatchObject({
      running: false,
      last: lastOf(summary as ScanSummary),
    });
  });

  it("answers a second press with outcome running, leaving the pass alone", async () => {
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ outcome: "running", scan: { running: true } });
  });

  it("reads the scan's rows once after the session, and writes nothing", () => {
    expect(firstShapes.slice(-2)).toEqual(["select property", "select library"]);
    expect(firstCost.rowsWritten).toBe(0);
  });
});
