import { library } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { database } from "../src/db";
import { sealCredentials } from "../src/storage/credentials";
import { FakeS3, installFakeS3, libraryTestBucket } from "./fake-s3";
import {
  ADMIN,
  ARCHIVE,
  afterAuthentication,
  countingApp,
  ids,
  LISTENER_BOTH,
  LISTENER_TWO,
  SHARED_KEY,
  seedTwoLibraries,
} from "./library-scope-support";
import { encryptionKey, testEnv } from "./support";

/**
 * Library 2's bytes, read from its own bucket over the S3 API (#84, "storage
 * per track's library", ticket D2): `stream`, `download`, `getLyricsBySongId`
 * and `getLyrics` read a library-2 track through `storageFor`, from the fake
 * S3 (test/fake-s3.ts), and answer exactly as they answer for library 1;
 * covers stay in the bound bucket.
 *
 * D1's fixtures, with library 2's row pointed at the fake and given a sealed
 * token. The shared key holds the same bytes in both buckets, so a library-1
 * response is what a library-2 one must equal.
 */

const { d1, call, fetch } = countingApp();
const fake = new FakeS3();
const CALM_KEY = "Only Two/Second Only/01 Calm.flac";
const BYTES = new TextEncoder().encode("0123456789abcdefghij, the same in both buckets");
const tr = (id: string) => `tr-${id}`;

beforeAll(async () => {
  await seedTwoLibraries();
  const path = `s3://${fake.host}/${fake.bucket}`;
  await database(testEnv)
    .update(library)
    .set({
      path,
      endpoint: fake.endpoint,
      bucket: fake.bucket,
      credentials: await sealCredentials(encryptionKey(), path, fake.credentials()),
    })
    .where(eq(library.id, ARCHIVE.id));

  await testEnv.MUSIC.put(SHARED_KEY, BYTES);
  await libraryTestBucket().put(SHARED_KEY, BYTES);
  await libraryTestBucket().put(CALM_KEY, new TextEncoder().encode("calm, library 2"));
  await libraryTestBucket().put(
    "Only Two/Second Only/01 Calm.lrc",
    "[00:01.00]a calm line from library 2\n",
  );
  await testEnv.MUSIC.put("_covers/second-only.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));

  for (const user of [ADMIN, LISTENER_TWO, LISTENER_BOTH]) {
    await call(user, "ping");
  }
});

beforeEach(() => {
  installFakeS3(fake);
  fake.calls.length = 0;
});

afterAll(() => {
  vi.restoreAllMocks();
});

/** A response's status, headers but the ones that name a time, and body. */
async function answered(response: Response) {
  const headers = [...response.headers].filter(
    ([name]) => name !== "date" && name !== "last-modified",
  );
  return { status: response.status, headers, body: await response.text() };
}

describe("streaming a library-2 track", () => {
  const CASES: readonly (readonly [string, RequestInit | undefined])[] = [
    ["a whole GET", undefined],
    ["a range", { headers: { Range: "bytes=2-9" } }],
    ["an open range", { headers: { Range: "bytes=40-" } }],
    ["a suffix range", { headers: { Range: "bytes=-5" } }],
    ["a range past the end", { headers: { Range: "bytes=999-" } }],
    ["a HEAD", { method: "HEAD" }],
    ["a ranged HEAD", { method: "HEAD", headers: { Range: "bytes=0-3" } }],
  ];

  it.each(["stream", "download"])(
    "%s answers exactly as for library 1, from the library's own bucket",
    async (endpoint) => {
      for (const [label, init] of CASES) {
        for (const user of [ADMIN, LISTENER_BOTH]) {
          const one = await answered(
            await fetch(user, endpoint, [["id", tr(ids.sharedTrack1)]], init),
          );
          fake.calls.length = 0;
          const two = await answered(
            await fetch(user, endpoint, [["id", tr(ids.sharedTrack2)]], init),
          );

          expect(two, `${endpoint} ${label} ${user}`).toEqual(one);
          expect(
            fake.calls.every((entry) => entry.key === SHARED_KEY && entry.signatureValid),
          ).toBe(true);
          expect(fake.calls.length).toBeGreaterThan(0);
        }
      }

      const forTwo = await fetch(LISTENER_TWO, endpoint, [["id", tr(ids.calmTrack)]]);
      expect(forTwo.status).toBe(200);
      expect(await forTwo.text()).toBe("calm, library 2");
    },
  );

  it("answers 416 for a range past the end, as for library 1", async () => {
    const response = await fetch(LISTENER_TWO, "stream", [["id", tr(ids.sharedTrack2)]], {
      headers: { Range: "bytes=999-" },
    });
    expect(response.status).toBe(416);
  });

  it("makes at most four subrequests: two statements and two S3 requests", async () => {
    for (const user of [LISTENER_TWO, ADMIN]) {
      d1.reset();
      fake.calls.length = 0;
      const response = await fetch(user, "stream", [["id", tr(ids.calmTrack)]], {
        headers: { Range: "bytes=0-3" },
      });
      expect(response.status).toBe(206);
      await response.arrayBuffer();

      expect(d1.roundTrips()).toBe(2);
      expect(afterAuthentication(d1.statements)[0]?.sql).toMatch(/\bjoin "library"/);
      expect(fake.calls.map((entry) => entry.operation)).toEqual(["HeadObject", "GetObject"]);
      expect(d1.roundTrips() + fake.calls.length).toBeLessThanOrEqual(4);
    }
  });
});

describe("lyrics of a library-2 track", () => {
  it("getLyricsBySongId reads the sidecar from the library's bucket", async () => {
    d1.reset();
    const body = await call(LISTENER_TWO, "getLyricsBySongId", [["id", tr(ids.calmTrack)]]);

    expect(body.lyricsList.structuredLyrics[0].line[0].value).toBe("a calm line from library 2");
    expect(fake.calls.map((entry) => [entry.operation, entry.key])).toEqual([
      ["GetObject", "Only Two/Second Only/01 Calm.lrc"],
    ]);
    expect(d1.roundTrips() + fake.calls.length).toBeLessThanOrEqual(4);
  });

  it("getLyrics finds a library-2 candidate and reads its sidecar there", async () => {
    const body = await call(LISTENER_TWO, "getLyrics", [
      ["artist", "Only Two"],
      ["title", "01 Calm"],
    ]);

    expect(body.lyrics.value).toBe("a calm line from library 2\n");
    expect(fake.calls.every((entry) => entry.signatureValid)).toBe(true);
  });
});

describe("a library-2 album's cover", () => {
  it("is served from the bound bucket, with no S3 request", async () => {
    const response = await fetch(LISTENER_TWO, "getCoverArt", [["id", `al-${ids.secondOnly}`]]);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    );
    expect(fake.calls).toEqual([]);
  });
});
