import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { readLastScanSummary, readScanProgress, type ScanProgress } from "../src/scanner/state";
import { driverIsIdle, driveUntilIdle, poke, runNextAlarm, slowTuning } from "./driver-support";
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

/** The instant the in-flight pass at the end of this file is stamped with. */
const IN_FLIGHT_POKE = new Date(1_750_000_000_000);

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

  it("reports the completed pass's count once it is over", async () => {
    const summary = await readLastScanSummary(database(testEnv));

    expect(summary?.counts.examined).toBeGreaterThan(0);
    expect(afterwards.scanStatus).toEqual({
      scanning: false,
      count: summary?.counts.examined,
      lastScan: new Date(summary?.finishedAt ?? 0).toISOString(),
    });
  });

  it("carries the last scan's instant in XML too", async () => {
    const summary = await readLastScanSummary(database(testEnv));
    const document = await xml("getScanStatus");

    expect(document).toContain('scanning="false"');
    expect(document).toContain(`lastScan="${new Date(summary?.finishedAt ?? 0).toISOString()}"`);
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

  it("is reported as scanning, with what it has examined so far", () => {
    expect(progressBefore?.counts.examined).toBeGreaterThan(0);
    expect(duringPass.scanStatus).toMatchObject({
      scanning: true,
      count: progressBefore?.counts.examined,
    });
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
    expect(progressAfter?.counts.examined).toBe(progressBefore?.counts.examined);
  });

  it("finishes under its own stamp, and is then reported as idle", async () => {
    await driveUntilIdle();

    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.startedAt).toBe(IN_FLIGHT_POKE.getTime());

    expect((await call("getScanStatus")).scanStatus).toMatchObject({
      scanning: false,
      count: summary?.counts.examined,
    });
  });
});
