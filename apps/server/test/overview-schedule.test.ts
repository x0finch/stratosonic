import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { RESCAN_QUIET_MS } from "../src/scanner/driver";
import { markLibraryChanged } from "../src/scanner/status";
import { bootstrapAdmin } from "./browsing-support";
import {
  type CookieJar,
  consoleRequest,
  cost,
  countingD1,
  seedConsoleUser,
  signIn,
} from "./console-auth-support";
import {
  driverIsIdle,
  driveUntilIdle,
  nextAlarmAt,
  poke,
  runNextAlarm,
  slowTuning,
  storedKeys,
} from "./driver-support";
import { seedFixtureFiles } from "./scan-support";
import { testEnv } from "./support";

/**
 * `scan.scheduled` of `GET /api/overview/live` (#83, "The console's view is
 * mirrored in D1"): in each state the debounced rescan goes through, what the
 * console is told must agree with what the real driver then does, and the
 * polled route must learn it from D1 alone, with no Durable Object request.
 *
 * The change is marked as a file route marks it (`markLibraryChanged`), with
 * production's window; the passes run with `slowTuning`, so only the test
 * fires a step.
 */

const ORIGIN = "https://overview-schedule.stratosonic.test";
const d1 = countingD1(testEnv.DB);
const env: Env = { ...testEnv, DB: d1.binding };
const app = createApp();
const send = (request: Request, onEnv: Env = env) => app.request(request, undefined, onEnv);

/** The live route's environment: a driver that fails any request made of it. */
const noDriver = {
  ...env,
  SCAN_DRIVER: {
    idFromName: (name: string) => testEnv.SCAN_DRIVER.idFromName(name),
    get: () => {
      throw new Error("the polled route asked the driver");
    },
  },
} as unknown as Env;

let owner: CookieJar;

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();
  await seedConsoleUser("Owner", "overview");
  owner = (await signIn(send, ORIGIN, "owner", "overview")).jar;
});

/** `scan.scheduled` as the console polls it, checking the poll's cost on the way. */
async function scheduled(): Promise<unknown> {
  d1.reset();
  const response = await send(
    consoleRequest(ORIGIN, "/api/overview/live", { jar: owner }),
    noDriver,
  );
  expect(response.status).toBe(200);
  expect(cost(d1.statements)).toMatchObject({ roundTrips: 1, rowsWritten: 0 });

  return ((await response.json()) as { scan: { scheduled: unknown } }).scan.scheduled;
}

/** Fires alarms until the pass in flight has ended. */
async function finishThePass(limit = 30): Promise<void> {
  for (let alarms = 0; alarms <= limit; alarms++) {
    if (!(await storedKeys()).includes("driver")) {
      return;
    }
    await runNextAlarm();
  }

  throw new Error(`the pass was still running after ${limit} alarms`);
}

describe("scan.scheduled through a change, a pass and Scan now", () => {
  // Made a moment ago, so a cron poke stamped just before it can start.
  const changedAt = Date.now() - 5_000;
  const due = changedAt + RESCAN_QUIET_MS;
  const scheduledFor = { scheduledAt: new Date(due).toISOString(), afterCurrentPass: false };

  it("is null before the console has changed a file", async () => {
    expect(await scheduled()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });

  it("names the time the driver's alarm is due after a change", async () => {
    expect(await markLibraryChanged(testEnv, changedAt)).toEqual(scheduledFor);

    expect(await scheduled()).toEqual(scheduledFor);
    expect(await storedKeys()).toEqual(["pending"]);
    expect(await nextAlarmAt()).toBe(due);
  });

  it("says another pass follows one a cron poke stamped before the change started", async () => {
    // One track a step, so the pass is in flight after its first.
    await poke(new Date(changedAt - 1_000), {
      ...slowTuning,
      scanLimits: { extractionsPerRun: 1 },
    });
    await runNextAlarm();

    expect(await scheduled()).toEqual({ scheduledAt: null, afterCurrentPass: true });
    expect(await storedKeys()).toEqual(["driver", "pending"]);
  });

  it("names the follow-up's time once that pass ends, as the driver queued it", async () => {
    await finishThePass();

    expect(await scheduled()).toEqual(scheduledFor);
    expect(await storedKeys()).toEqual(["pending"]);
    expect(await nextAlarmAt()).toBe(due);
  });

  it("is null once Scan now has taken the change, with no follow-up", async () => {
    const response = await send(
      consoleRequest(ORIGIN, "/api/library/scan", { jar: owner, method: "POST", body: {} }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: "started",
      scan: { running: true, scheduled: null },
    });
    expect(await storedKeys()).toEqual(["driver", "pending"]);

    await driveUntilIdle();

    expect(await scheduled()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });
});
