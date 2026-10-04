import { runInDurableObject } from "cloudflare:test";
import { property } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { RESCAN_QUIET_MS, type ScanDriver } from "../src/scanner/driver";
import {
  noCounts,
  readScanReport,
  type ScanReport,
  writeLibraryChangedAtStatement,
} from "../src/scanner/state";
import { markLibraryChanged, scanSchedule } from "../src/scanner/status";
import { cost, countingD1, shape } from "./console-auth-support";
import { driver, nextAlarmAt, storedKeys } from "./driver-support";
import { testEnv } from "./support";

/**
 * The console's view of the debounced rescan (#83, "The console's view is
 * mirrored in D1"): the `LibraryChangedAt` row the file routes write,
 * `scanSchedule`, which reads what the driver will do from it by the
 * driver's own rule, and `markLibraryChanged`, the helper the routes call.
 */

const T = 1_780_000_000_000;

/** A report with nothing in flight, nothing completed and nothing changed. */
function report(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    progress: null,
    importingPlaylists: false,
    importStartedAt: null,
    lastCompleted: null,
    lastChangedAt: null,
    rowsWritten: null,
    ...overrides,
  };
}

function inFlightSince(startedAt: number): Partial<ScanReport> {
  return {
    progress: {
      startedAt,
      libraryId: 1,
      cursor: "",
      skip: 0,
      sweptTo: "",
      restarted: false,
      counts: noCounts(),
      libraries: {},
      untallied: null,
    },
  };
}

function completedAt(startedAt: number): Partial<ScanReport> {
  return {
    lastCompleted: { startedAt, finishedAt: startedAt + 60_000, counts: noCounts(), libraries: {} },
  };
}

const scheduledFor = (changedAt: number) => ({
  scheduledAt: new Date(changedAt + RESCAN_QUIET_MS).toISOString(),
  afterCurrentPass: false,
});

const afterCurrentPass = { scheduledAt: null, afterCurrentPass: true };

describe("scanSchedule", () => {
  it("is null when the console has never changed a file", () => {
    expect(scanSchedule(report())).toBeNull();
    expect(scanSchedule(report(inFlightSince(T)))).toBeNull();
  });

  it("schedules a pass two minutes after a change when no pass has ever run", () => {
    expect(scanSchedule(report({ lastChangedAt: T }))).toEqual(scheduledFor(T));
  });

  it("schedules a pass after a change made since the last completed one began", () => {
    expect(scanSchedule(report({ ...completedAt(T), lastChangedAt: T + 1 }))).toEqual(
      scheduledFor(T + 1),
    );
    // A change at the very instant the pass was stamped with is not covered
    // by it, as the driver decides (`changedAt >= startedAt`).
    expect(scanSchedule(report({ ...completedAt(T), lastChangedAt: T }))).toEqual(scheduledFor(T));
  });

  it("is null for a change the last completed pass covered", () => {
    expect(scanSchedule(report({ ...completedAt(T), lastChangedAt: T - 1 }))).toBeNull();
  });

  it("follows the pass in flight with one more for a change since it began", () => {
    expect(
      scanSchedule(report({ ...completedAt(T - 900_000), ...inFlightSince(T), lastChangedAt: T })),
    ).toEqual(afterCurrentPass);
  });

  it("is null for a change made before the pass in flight began", () => {
    // The last completed pass began before the change, but the one in flight
    // is the latest pass, and it covers it.
    expect(
      scanSchedule(
        report({ ...completedAt(T - 900_000), ...inFlightSince(T), lastChangedAt: T - 1 }),
      ),
    ).toBeNull();
  });

  it("reads the import's stamp while the pass imports playlists", () => {
    const importing = { importingPlaylists: true, importStartedAt: T };
    expect(
      scanSchedule(report({ ...completedAt(T - 900_000), ...importing, lastChangedAt: T + 5 })),
    ).toEqual(afterCurrentPass);
    expect(
      scanSchedule(report({ ...completedAt(T - 900_000), ...importing, lastChangedAt: T - 5 })),
    ).toBeNull();
  });

  it("falls back to the last completed pass when the import's row will not parse", () => {
    const importing = { importingPlaylists: true, importStartedAt: null };
    expect(scanSchedule(report({ ...completedAt(T), ...importing, lastChangedAt: T + 1 }))).toEqual(
      afterCurrentPass,
    );
  });

  it("keeps a time already past, which the console reads as starting", () => {
    const changedAt = Date.now() - 10 * RESCAN_QUIET_MS;
    const schedule = scanSchedule(report({ lastChangedAt: changedAt }));
    expect(schedule).toEqual(scheduledFor(changedAt));
    expect(Date.parse(schedule?.scheduledAt ?? "")).toBeLessThan(Date.now());
  });

  it("takes a pass its caller has just started, before it writes anything", () => {
    // Scan now: the poke at T + 10 covers a change at T + 5.
    const changed = report({ ...completedAt(T), lastChangedAt: T + 5 });
    expect(scanSchedule(changed, true, T + 10)).toBeNull();
    // A pass already in flight since T: one more follows it.
    expect(scanSchedule(changed, true)).toEqual(afterCurrentPass);
  });
});

/* ====================================================== the row == */

describe("the LibraryChangedAt row", () => {
  const db = database(testEnv);

  async function stored(): Promise<string | undefined> {
    const rows = await db.select().from(property).where(eq(property.id, "LibraryChangedAt"));
    return rows[0]?.value;
  }

  it("is written by the first change and read into the report", async () => {
    await writeLibraryChangedAtStatement(db, T);

    expect(JSON.parse((await stored()) ?? "")).toEqual({ at: T });
    expect((await readScanReport(db)).lastChangedAt).toBe(T);
  });

  it("moves forward with a later change", async () => {
    await writeLibraryChangedAtStatement(db, T + 1_000);

    expect((await readScanReport(db)).lastChangedAt).toBe(T + 1_000);
  });

  it("never moves back for an earlier change, or the same one", async () => {
    await writeLibraryChangedAtStatement(db, T);
    await writeLibraryChangedAtStatement(db, T + 1_000);

    expect((await readScanReport(db)).lastChangedAt).toBe(T + 1_000);
  });

  it("replaces a stored row that will not parse", async () => {
    for (const unreadable of ["", "not json", '{"at":"soon"}', "[]"]) {
      await db
        .update(property)
        .set({ value: unreadable })
        .where(eq(property.id, "LibraryChangedAt"));
      expect((await readScanReport(db)).lastChangedAt).toBeNull();

      await writeLibraryChangedAtStatement(db, T);
      expect((await readScanReport(db)).lastChangedAt).toBe(T);

      await writeLibraryChangedAtStatement(db, T + 1_000);
    }
  });

  it("costs one statement that writes one row", async () => {
    const d1 = countingD1(testEnv.DB);
    await writeLibraryChangedAtStatement(database({ ...testEnv, DB: d1.binding }), T + 2_000);

    expect(d1.statements.map(shape)).toEqual(["insert property"]);
    expect(cost(d1.statements)).toMatchObject({ statements: 1, roundTrips: 1, rowsWritten: 1 });
  });
});

/* ============================================ markLibraryChanged == */

describe("markLibraryChanged", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    // No pass is wanted here: what is left is a change nothing will scan.
    await runInDurableObject(driver(), async (_instance: ScanDriver, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  });

  it("writes the row, then touches the driver, which schedules the pass", async () => {
    const d1 = countingD1(testEnv.DB);
    const at = Date.now();

    const schedule = await markLibraryChanged({ ...testEnv, DB: d1.binding }, at);

    expect(schedule).toEqual(scheduledFor(at));
    expect(d1.statements.map(shape)).toEqual(["insert property"]);
    expect((await readScanReport(database(testEnv))).lastChangedAt).toBe(at);
    expect(await storedKeys()).toContain("pending");
    expect(await nextAlarmAt()).toBe(at + RESCAN_QUIET_MS);
  });

  it("takes an instant in the future as now, in the row and in the touch", async () => {
    let touchedWith = 0;
    const recording = {
      ...testEnv,
      SCAN_DRIVER: {
        idFromName: (name: string) => testEnv.SCAN_DRIVER.idFromName(name),
        get: () => ({
          touch: async (at: number) => {
            touchedWith = at;
            return null;
          },
        }),
      },
    } as unknown as Env;

    const before = Date.now();
    await markLibraryChanged(recording, before + 3_600_000);
    const after = Date.now();

    const stored = (await readScanReport(database(testEnv))).lastChangedAt ?? 0;
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThanOrEqual(after);
    expect(touchedWith).toBe(stored);
  });

  it("passes on the driver's answer that the pass in flight covers the change", async () => {
    const covered = { scheduledAt: null, afterCurrentPass: false };
    const covering = {
      ...testEnv,
      SCAN_DRIVER: {
        idFromName: (name: string) => testEnv.SCAN_DRIVER.idFromName(name),
        get: () => ({ touch: async () => covered }),
      },
    } as unknown as Env;

    expect(await markLibraryChanged(covering, Date.now())).toEqual(covered);
  });

  it("answers null when the driver cannot be reached, and the change stands", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const at = Date.now();
    const unreachable = {
      ...testEnv,
      SCAN_DRIVER: {
        idFromName: (name: string) => testEnv.SCAN_DRIVER.idFromName(name),
        get: () => ({ touch: () => Promise.reject(new Error("the driver is unreachable")) }),
      },
    } as unknown as Env;

    expect(await markLibraryChanged(unreachable, at)).toBeNull();
    expect((await readScanReport(database(testEnv))).lastChangedAt).toBe(at);
    expect(logged).toHaveBeenCalled();
  });

  it("throws when the row cannot be written, and touches nothing", async () => {
    let touched = false;
    const broken = {
      ...testEnv,
      DB: {
        prepare: () => {
          throw new Error("D1 is unreachable");
        },
      },
      SCAN_DRIVER: {
        idFromName: (name: string) => testEnv.SCAN_DRIVER.idFromName(name),
        get: () => ({
          touch: async () => {
            touched = true;
            return null;
          },
        }),
      },
    } as unknown as Env;

    await expect(markLibraryChanged(broken, Date.now())).rejects.toThrow();
    expect(touched).toBe(false);
  });
});
