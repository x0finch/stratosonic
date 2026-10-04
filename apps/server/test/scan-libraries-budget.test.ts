import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { ROWS_PER_INDEXED_TRACK } from "../src/scanner/budget";
import { DEFAULT_SCAN_LIMITS, runScan, type ScanRun } from "../src/scanner/scan";
import { bootstrapAdmin } from "./browsing-support";
import { cost, countingD1, type RecordedStatement } from "./console-auth-support";
import type { FakeS3 } from "./fake-s3";
import { fixtureBytes } from "./fixtures/files";
import {
  connectLibrary,
  type FakeLibrary,
  installFakeLibrary,
  putInArchive,
  resetLibraries,
} from "./scan-libraries-support";
import { testEnv } from "./support";

/**
 * The scan step's subrequest budget across libraries (#84, "The step budget,
 * recomputed for S3"; "Free-tier budget"): every D1 round trip, every call
 * of the bound bucket's binding and every request to the fake S3 endpoint
 * counts as one subrequest, and a step makes at most 42 of the free plan's
 * 50, with at most 21 of them over `fetch`.
 *
 * Each step runs as the driver runs it, with the production limits
 * (`DEFAULT_SCAN_LIMITS`), against a D1 that records every statement, a
 * binding that records every call, and the fake's own record of requests.
 * Library 2's tracks are MP3s whose ID3v2 tag carries a 600 KB picture, so
 * reading one takes three or four range reads of 256 KiB (#21's worst case)
 * and every track gives its album a cover: the steps are as heavy as the
 * budget table's.
 */

/** What one step made, by kind of subrequest. */
interface StepCost {
  readonly run: ScanRun;
  readonly d1: RecordedStatement[];
  readonly d1Trips: number;
  readonly binding: string[];
  readonly fetches: string[];
  readonly total: number;
}

/** A binding that records each call's method. */
function countingBinding(inner: R2Bucket, calls: string[]): R2Bucket {
  return new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return value.apply(target, args);
      };
    },
  });
}

/* ------------------------------------------------- a heavy MP3 -- */

const latin1 = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0));

function frame(id: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(10);
  header.set(latin1(id), 0);
  new DataView(header.buffer).setUint32(4, content.length);
  return concat([header, content]);
}

function textFrame(id: string, text: string): Uint8Array {
  return frame(id, concat([new Uint8Array([0]), latin1(text)]));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * An MP3 of the untagged fixture's frames behind an ID3v2.3 tag with a
 * title, an artist, an album and a `picture`-byte PNG. Each track is its
 * own artist's own album unless `album` names a shared one.
 */
function heavyMp3(
  index: number,
  picture: number,
  album: { artist: string; name: string } = {
    artist: `Heavy Artist ${index}`,
    name: `Heavy Album ${index}`,
  },
): Uint8Array {
  const image = new Uint8Array(picture);
  image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let at = 8; at < picture; at++) {
    image[at] = (at * 31 + index) & 0xff;
  }
  const frames = concat([
    textFrame("TIT2", `Heavy ${index}`),
    textFrame("TPE1", album.artist),
    textFrame("TALB", album.name),
    frame(
      "APIC",
      concat([new Uint8Array([0]), latin1("image/png\0"), new Uint8Array([3, 0]), image]),
    ),
  ]);
  const size = frames.length;
  const header = new Uint8Array([
    0x49,
    0x44,
    0x33,
    3,
    0,
    0,
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ]);
  return concat([header, frames, fixtureBytes("untagged.mp3")]);
}

/* ------------------------------------------------------ the run -- */

let fake: FakeS3;
let installed: FakeLibrary;

/** Runs one step, stamped `now`, with every subrequest counted. */
async function countedStep(now: Date): Promise<StepCost> {
  const d1 = countingD1(testEnv.DB);
  const binding: string[] = [];
  const env: Env = { ...testEnv, DB: d1.binding, MUSIC: countingBinding(testEnv.MUSIC, binding) };
  const before = fake.calls.length;
  const run = await runScan(env, now, DEFAULT_SCAN_LIMITS, { writeBudget: 0 });
  const fetches = fake.calls.slice(before).map((call) => call.operation);
  const d1Trips = cost(d1.statements).roundTrips;

  return {
    run,
    d1: [...d1.statements],
    d1Trips,
    binding,
    fetches,
    total: d1Trips + binding.length + fetches.length,
  };
}

/** Every step of a pass, counted, until it completes. */
async function countedPass(now: Date, limit = 100): Promise<StepCost[]> {
  const steps: StepCost[] = [];
  for (let step = 0; step < limit; step++) {
    const counted = await countedStep(now);
    steps.push(counted);
    if (counted.run.completed) {
      return steps;
    }
  }
  throw new Error(`the pass was still running after ${limit} steps`);
}

/** Heavy tracks in library 2, each its own artist and album. */
const TRACKS = 13;
/** Objects that are not music, so the listing has three pages to walk. */
const OTHERS = 257;

beforeAll(async () => {
  await bootstrapAdmin();
  await resetLibraries();
  installed = installFakeLibrary();
  fake = installed.fake;
  await connectLibrary(fake);
  for (let index = 0; index < TRACKS; index++) {
    await putInArchive(
      `Heavy ${String(index).padStart(2, "0")}/Album/01 Track.mp3`,
      heavyMp3(index, 600_000),
    );
  }
  for (let index = 0; index < OTHERS; index++) {
    await putInArchive(`Notes/${String(index).padStart(3, "0")}.txt`, new Uint8Array([index]));
  }
});

afterAll(() => {
  installed.spy.mockRestore();
});

describe("a first index of library 2 over S3", () => {
  let steps: StepCost[] = [];

  beforeAll(async () => {
    steps = await countedPass(new Date(1_790_000_000_000));
  });

  it("makes at most 42 subrequests a step, at most 21 of them over fetch", () => {
    for (const step of steps) {
      expect(step.total).toBeLessThanOrEqual(42);
      expect(step.fetches.length).toBeLessThanOrEqual(21);
    }
  });

  it("is as heavy as the table: six reads of three or more ranges and six covers a step", () => {
    const heaviest = steps[0];
    expect(heaviest?.run.counts.indexed).toBe(6);
    expect(
      heaviest?.fetches.filter((operation) => operation === "GetObject").length,
    ).toBeGreaterThanOrEqual(18);
    expect(heaviest?.binding.filter((method) => method === "put")).toHaveLength(6);
    expect(Math.max(...steps.map((step) => step.total))).toBeGreaterThanOrEqual(30);
  });

  it("puts nothing in library 2's bucket: its covers go to the bound one", () => {
    const operations = steps.flatMap((step) => step.fetches);
    expect(new Set(operations)).toEqual(new Set(["ListObjectsV2", "GetObject"]));
  });

  it("writes each track's rows: about 13 for a track that is its own artist's own album", () => {
    const written = steps.flatMap((step) => step.d1).reduce((sum, s) => sum + s.rowsWritten, 0);
    const perTrack = written / TRACKS;
    console.log(
      `first index of library 2: ${steps.length} steps, ${written} rows written, ` +
        `${perTrack.toFixed(1)} a track; subrequests a step: ` +
        steps
          .map((step) => `${step.d1Trips}+${step.binding.length}+${step.fetches.length}`)
          .join(" "),
    );
    // Every track here inserts an artist and an album with their indexes,
    // which a library of ten-track albums pays once an album (below).
    expect(perTrack).toBeGreaterThan(ROWS_PER_INDEXED_TRACK);
    expect(perTrack).toBeLessThanOrEqual(2 * ROWS_PER_INDEXED_TRACK);
  });
});

describe("an unchanged pass over both libraries", () => {
  let steps: StepCost[] = [];

  beforeAll(async () => {
    steps = await countedPass(new Date(1_790_000_100_000));
  });

  it("makes at most 42 subrequests a step", () => {
    for (const step of steps) {
      expect(step.total).toBeLessThanOrEqual(42);
    }
  });

  it("writes one row a page, and the tally only at the pass's end", () => {
    const all = steps.flatMap((step) => step.d1);
    const lists =
      steps.flatMap((step) => step.fetches).filter((operation) => operation === "ListObjectsV2")
        .length +
      steps.flatMap((step) => step.binding).filter((method) => method === "list").length;
    console.log(
      `unchanged pass: ${steps.length} steps, ${lists} listings, ${JSON.stringify(cost(all))}`,
    );

    // Library 1's one (empty) page and library 2's three: one progress row a
    // page, one stamp a library (entered and left in one statement when it
    // fits a page, two otherwise), then the summary, the cleared progress
    // and the tally at the end.
    expect(lists).toBe(4);
    const written = all.filter((statement) => statement.rowsWritten > 0);
    expect(written.filter((statement) => statement.sql.includes('"property"')).length).toBe(4 + 3);
    expect(
      all.filter(
        (statement) =>
          /^insert into "property"/i.test(statement.sql) && statement.sql.includes("json_object"),
      ).length,
    ).toBe(1);
  });
});

describe("a first index of ten-track albums", () => {
  it("writes about the 8 rows a track the daily budget counts", async () => {
    // Twenty more tracks, ten an album, both albums one artist's.
    for (let index = 0; index < 20; index++) {
      await putInArchive(
        `Shared Artist/Album ${index < 10 ? "A" : "B"}/${String(index).padStart(2, "0")} Track.mp3`,
        heavyMp3(100 + index, 600_000, {
          artist: "Shared Artist",
          name: `Shared Album ${index < 10 ? "A" : "B"}`,
        }),
      );
    }

    const steps = await countedPass(new Date(1_790_000_200_000));
    const written = steps.flatMap((step) => step.d1).reduce((sum, s) => sum + s.rowsWritten, 0);
    const indexed = steps.reduce((sum, step) => sum + step.run.counts.indexed, 0);
    console.log(
      `ten-track albums: ${steps.length} steps, ${indexed} tracks, ${written} rows written, ` +
        `${(written / indexed).toFixed(1)} a track`,
    );
    expect(indexed).toBe(20);
    for (const step of steps) {
      expect(step.total).toBeLessThanOrEqual(42);
    }
    // With the pass's own progress, stamps, summary and tally rows spread over it.
    expect(written / indexed).toBeLessThanOrEqual(ROWS_PER_INDEXED_TRACK + 2);
  });
});
