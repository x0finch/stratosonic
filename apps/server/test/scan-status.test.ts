import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { readPlaylistImportProgress } from "../src/playlists/state";
import { readLastScanSummary, readScanProgress, type ScanProgress } from "../src/scanner/state";
import { driverIsIdle, driveUntilIdle, poke, runNextAlarm, slowTuning } from "./driver-support";
import { fixtures } from "./fixtures/files";
import { resetLibrary, seedFixtureFiles } from "./scan-support";
import { BASE, seedUser, testEnv } from "./support";

/**
 * `startScan` and `getScanStatus` (#62), over the Worker.
 *
 * Both endpoints are reached the way a client reaches them — `SELF.fetch`,
 * with the bootstrap admin's credentials — and the scan behind them is the
 * real one: the Durable Object the binding creates, driven by the same
 * helpers the driver's own tests use. What the endpoints say is checked
 * against the `property` rows the pass writes, because those rows are what
 * they are supposed to be reading.
 */

/** The bootstrap admin from vitest.config.ts, and someone who is not one. */
const ADMIN = "admin";
const LISTENER = "listener";
const PASSWORD = "sesame";

/** The instant the in-flight pass in this file is stamped with. */
const IN_FLIGHT_POKE = new Date(1_750_000_000_000);

/** And the one whose playlist import is caught half done. */
const IMPORT_POKE = new Date(IN_FLIGHT_POKE.getTime() + 15 * 60_000);

/** What `count` reports: the tracks a pass accounted for, read or skipped. */
function tracksOf(counts: { indexed: number; unchanged: number }): number {
  return counts.indexed + counts.unchanged;
}

/** `<scanStatus>`, as the JSON rendering carries it. */
interface ScanStatusElement {
  scanning: boolean;
  count: number;
  lastScan?: string;
}

interface ScanStatusResponse {
  status: string;
  error?: { code: number; message: string };
  scanStatus?: ScanStatusElement;
}

interface ScanStatusEnvelope {
  "subsonic-response": ScanStatusResponse;
}

function credentials(userName = ADMIN, password = PASSWORD): URLSearchParams {
  return new URLSearchParams({ u: userName, p: password, v: "1.16.1", c: "Substreamer" });
}

interface CallOptions {
  readonly userName?: string;
  readonly password?: string;
  /** The URL form to use; both are mounted. */
  readonly path?: string;
  readonly method?: "GET" | "POST";
}

/** One call, in JSON, as whoever the options name. */
async function call(endpoint: string, options: CallOptions = {}): Promise<ScanStatusResponse> {
  const params = credentials(options.userName, options.password);
  params.set("f", "json");

  const path = options.path ?? `/rest/${endpoint}`;
  const response =
    options.method === "POST"
      ? await SELF.fetch(`${BASE}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        })
      : await SELF.fetch(`${BASE}${path}?${params}`);

  return ((await response.json()) as ScanStatusEnvelope)["subsonic-response"];
}

/** The same call, in the default rendering, as the raw document. */
async function xml(endpoint: string): Promise<string> {
  return (await SELF.fetch(`${BASE}/rest/${endpoint}?${credentials()}`)).text();
}

beforeAll(async () => {
  // The bootstrap only creates the admin while the user table is empty, so the
  // first request has to reach the Worker before anything else is seeded.
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedUser(LISTENER, PASSWORD);
});

/* ============================================ a server that never scanned == */

describe("a server whose library has never been scanned", () => {
  it("answers scanning=false and count=0 rather than an error, in XML", async () => {
    const document = await xml("getScanStatus");

    expect(document).toContain('status="ok"');
    expect(document).toContain('<scanStatus scanning="false" count="0"/>');
  });

  it.each(["/rest/getScanStatus", "/rest/getScanStatus.view"])(
    "answers the same on %s, in JSON",
    async (path) => {
      const body = await call("getScanStatus", { path });

      expect(body.status).toBe("ok");
      expect(body.scanStatus).toEqual({ scanning: false, count: 0 });
    },
  );

  it("answers a form-encoded POST the same way", async () => {
    const body = await call("getScanStatus", { method: "POST" });

    expect(body.scanStatus).toEqual({ scanning: false, count: 0 });
  });

  it.each(["getScanStatus", "startScan"])(
    "refuses %s to a listener with error 50",
    async (name) => {
      const body = await call(name, { userName: LISTENER });

      expect(body).toMatchObject({
        status: "failed",
        error: { code: 50, message: "User is not authorized for the given operation" },
      });
      expect(body.scanStatus).toBeUndefined();
    },
  );

  it.each(["getScanStatus", "startScan"])(
    "checks the credentials before the admin flag on %s",
    async (name) => {
      const body = await call(name, { userName: LISTENER, password: "open-sesame" });

      expect(body).toMatchObject({ status: "failed", error: { code: 40 } });
    },
  );

  it("has started nothing while refusing all of that", async () => {
    expect(await driverIsIdle()).toBe(true);
    expect((await call("getScanStatus")).scanStatus).toEqual({ scanning: false, count: 0 });
  });
});

/* ====================================================== startScan, idle == */

describe("startScan on a server with no pass in flight", () => {
  let started: ScanStatusResponse;
  let idleRightAfter = true;
  let afterwards: ScanStatusResponse;

  beforeAll(async () => {
    await seedFixtureFiles();

    started = await call("startScan");
    // Read before the first alarm is due: the poke arms the driver and
    // nothing else, exactly as the cron poke does.
    idleRightAfter = await driverIsIdle();

    await driveUntilIdle();
    afterwards = await call("getScanStatus");
  });

  it("answers that a scan is running", () => {
    expect(started.status).toBe("ok");
    // Nothing is examined yet: the pass is armed, and its first step - which
    // is what writes the counts - has not run.
    expect(started.scanStatus).toMatchObject({ scanning: true, count: 0 });
  });

  it("arms the driver, which then carries the pass to completion", async () => {
    expect(idleRightAfter).toBe(false);
    expect(await readLastScanSummary(database(testEnv))).not.toBeNull();
  });

  it("reports the completed pass's track count once it is over", async () => {
    const summary = await readLastScanSummary(database(testEnv));

    // The tracks the pass accounted for, not every object it looked at: the
    // bucket also holds the `.m3u` and the covers the pass itself wrote.
    expect(summary?.counts.indexed).toBe(fixtures.tracks.length);
    expect(afterwards.scanStatus).toEqual({
      scanning: false,
      count: tracksOf(summary?.counts ?? { indexed: 0, unchanged: 0 }),
      lastScan: new Date(summary?.finishedAt ?? 0).toISOString(),
    });
    expect(afterwards.scanStatus?.count).toBe(fixtures.tracks.length);
  });

  it("carries the last scan's instant in XML too", async () => {
    const summary = await readLastScanSummary(database(testEnv));
    const document = await xml("getScanStatus");

    expect(document).toContain('scanning="false"');
    expect(document).toContain(`lastScan="${new Date(summary?.finishedAt ?? 0).toISOString()}"`);
  });
});

/* ================================= startScan's other URL form and method == */

describe("startScan's second URL form and its form-encoded POST", () => {
  it.each([
    { what: "the .view form", path: "/rest/startScan.view", method: "GET" as const },
    { what: "a form-encoded POST", path: "/rest/startScan", method: "POST" as const },
  ])("starts a pass through $what", async ({ path, method }) => {
    const body = await call("startScan", { path, method });

    expect(body.status).toBe("ok");
    expect(body.scanStatus?.scanning).toBe(true);

    // Left idle for whatever runs next: each describe here starts from a
    // driver that has stopped.
    await driveUntilIdle();
  });
});

/* ================================================ a pass already in flight == */

describe("a pass in flight", () => {
  let duringPass: ScanStatusResponse;
  let pokedAgain: ScanStatusResponse;
  let progressBefore: ScanProgress | null = null;
  let progressAfter: ScanProgress | null = null;

  beforeAll(async () => {
    await resetLibrary();
    await seedFixtureFiles();

    // One track a step, with the delays far enough out that no alarm fires
    // unless this test fires it, so the pass is still going after the first.
    await poke(IN_FLIGHT_POKE, { ...slowTuning, scanLimits: { extractionsPerRun: 1 } });
    await runNextAlarm();

    duringPass = await call("getScanStatus");
    progressBefore = await readScanProgress(database(testEnv));

    pokedAgain = await call("startScan");
    progressAfter = await readScanProgress(database(testEnv));
  });

  it("is reported as scanning, with the tracks it has reached so far", () => {
    expect(progressBefore?.counts.indexed).toBeGreaterThan(0);
    expect(duringPass.scanStatus).toMatchObject({
      scanning: true,
      count: tracksOf(progressBefore?.counts ?? { indexed: 0, unchanged: 0 }),
    });
    // Part of the library, not all of it: this is a pass still under way.
    expect(duringPass.scanStatus?.count).toBeLessThan(fixtures.tracks.length);
  });

  it("answers a second startScan with the same scanning=true", () => {
    expect(pokedAgain.status).toBe("ok");
    expect(pokedAgain.scanStatus?.scanning).toBe(true);
  });

  it("is not restarted by that second startScan", () => {
    // Had the poke been taken, the pass would carry the wall clock rather
    // than the instant the first poke stamped it with, and its steps would
    // have started over.
    expect(progressAfter?.startedAt).toBe(IN_FLIGHT_POKE.getTime());
    expect(progressAfter?.startedAt).toBe(progressBefore?.startedAt);
    expect(progressAfter?.counts.indexed).toBe(progressBefore?.counts.indexed);
  });

  it("finishes under its own stamp, and is then reported as idle", async () => {
    await driveUntilIdle();

    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.startedAt).toBe(IN_FLIGHT_POKE.getTime());

    expect((await call("getScanStatus")).scanStatus).toMatchObject({
      scanning: false,
      count: fixtures.tracks.length,
    });
    expect(tracksOf(summary?.counts ?? { indexed: 0, unchanged: 0 })).toBe(fixtures.tracks.length);
  });
});

/* ============================================ the second half of a pass == */

describe("a pass in its playlist-import phase", () => {
  let duringImport: ScanStatusResponse;

  beforeAll(async () => {
    await resetLibrary();
    await seedFixtureFiles();

    // One object a step for the import, so the second half of the pass takes
    // several alarms and can be caught in the middle of it.
    await poke(IMPORT_POKE, { ...slowTuning, playlistLimits: { objectsPerRun: 1 } });

    // Alarms until the scan's own pass is over - which is what writes the
    // summary and clears `ScanProgress` - and then one more, the import's
    // first step, which writes the row this phase is known by.
    for (let step = 0; step < 20; step++) {
      if ((await readLastScanSummary(database(testEnv))) !== null) {
        break;
      }

      await runNextAlarm();
    }
    await runNextAlarm();

    duringImport = await call("getScanStatus");
  });

  it("is caught with the scan's row gone and the import's row written", async () => {
    expect(await readScanProgress(database(testEnv))).toBeNull();
    expect(await readPlaylistImportProgress(database(testEnv))).not.toBeNull();
    expect(await driverIsIdle()).toBe(false);
  });

  it("is still reported as scanning", () => {
    // The gap this closes: the scan's pass has finished and written its
    // summary, so reading `ScanProgress` alone would call a pass that has
    // several alarms to go finished.
    expect(duringImport.scanStatus?.scanning).toBe(true);
  });

  it("keeps the count this pass's own scan half reached", () => {
    // The import indexes no tracks, but the scan that preceded it in this
    // same pass has already written its summary, so the number a client
    // watches climb stays where the scan left it instead of dipping to 0
    // for the second half of the pass.
    expect(duringImport.scanStatus?.count).toBe(fixtures.tracks.length);
  });

  it("is reported as idle once the import is over too", async () => {
    await driveUntilIdle();

    expect((await call("getScanStatus")).scanStatus).toMatchObject({
      scanning: false,
      count: fixtures.tracks.length,
    });
  });
});
