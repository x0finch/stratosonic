import { property } from "@stratosonic/db";
import { beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import {
  brokenObjectsKey,
  noCounts,
  readBrokenObjects,
  readScanProgress,
  resetLibraryScanStatements,
} from "../src/scanner/state";
import { resetLibraries } from "./scan-libraries-support";
import { testEnv } from "./support";

/**
 * Starting a library's scan over (#84, "Scanning several libraries": a
 * `PATCH` that changes a library's bucket resets its cursor, if the pass is
 * in it, and its memo, in the same batch). The libraries API (#84, ticket G)
 * puts these statements in its batch.
 */

async function inFlight(progress: Record<string, unknown>): Promise<void> {
  const db = database(testEnv);
  await db.insert(property).values([
    {
      id: "ScanProgress",
      value: JSON.stringify({
        startedAt: 1_000,
        cursor: "page-7",
        skip: 3,
        sweptTo: "M/N/07.mp3",
        counts: noCounts(),
        ...progress,
      }),
    },
    { id: brokenObjectsKey(1), value: JSON.stringify({ "a.mp3": "e1" }) },
    { id: brokenObjectsKey(2), value: JSON.stringify({ "b.mp3": "e2" }) },
  ]);
}

async function reset(libraryId: number): Promise<void> {
  const db = database(testEnv);
  const [first, ...rest] = resetLibraryScanStatements(db, libraryId);
  if (first !== undefined) {
    await db.batch([first, ...rest]);
  }
}

beforeEach(resetLibraries);

describe("resetting the library the pass is in", () => {
  it("lists it again from its start, and forgets its memo only", async () => {
    await inFlight({ libraryId: 2, restarted: true });
    await reset(2);

    const db = database(testEnv);
    expect(await readScanProgress(db)).toMatchObject({
      startedAt: 1_000,
      libraryId: 2,
      cursor: "",
      skip: 0,
      sweptTo: "",
      restarted: false,
    });
    expect((await readBrokenObjects(db, 2)).size).toBe(0);
    expect((await readBrokenObjects(db, 1)).get("a.mp3")).toBe("e1");
  });

  it("reads a v0.5.0 row, which names no library, as library 1's", async () => {
    await inFlight({});
    await reset(1);

    expect(await readScanProgress(database(testEnv))).toMatchObject({ libraryId: 1, cursor: "" });
  });
});

describe("resetting another library", () => {
  it("leaves the pass's cursor alone, and forgets that library's memo", async () => {
    await inFlight({ libraryId: 1 });
    await reset(2);

    const db = database(testEnv);
    expect(await readScanProgress(db)).toMatchObject({
      libraryId: 1,
      cursor: "page-7",
      skip: 3,
      sweptTo: "M/N/07.mp3",
    });
    expect((await readBrokenObjects(db, 2)).size).toBe(0);
    expect((await readBrokenObjects(db, 1)).size).toBe(1);
  });
});
