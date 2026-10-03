import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CHECK_BATCH, CHECK_CALLS, CHECK_ENTRIES, CHECK_LISTINGS } from "../src/api/files";
import { MAX_FILE_CHECK_BODY_BYTES } from "../src/api/json-body";
import { type CookieJar, GUEST_ROLE, seedConsoleUser, signIn } from "./console-auth-support";
import {
  allKeys,
  expectRefusal,
  type FilesHarness,
  filesHarness,
  resetDriver,
  seedObjects,
  UPLOADS_ENV,
} from "./files-support";
import { resetLibrary } from "./scan-support";
import { BASE, testEnv } from "./support";

/**
 * `POST /api/files/uploads/check` (#141): which of a pick's keys already
 * exist, asked before anything is signed, so the console can ask once
 * whether to replace or skip them. Through the Worker's app over the pool's
 * R2, each call recorded by the harness (test/files-support.ts).
 */

const ORIGIN = "https://uploads-check.stratosonic.test";
const harness = filesHarness(ORIGIN, { uploads: UPLOADS_ENV });

let owner: CookieJar;
let guest: CookieJar;

beforeAll(async () => {
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedConsoleUser("owner", "check");
  await seedConsoleUser("guest", "nothing", GUEST_ROLE);
  owner = (await signIn(harness.send, ORIGIN, "owner", "check")).jar;
  guest = (await signIn(harness.send, ORIGIN, "guest", "nothing")).jar;
});

beforeEach(async () => {
  await resetLibrary();
  // resetLibrary deletes one page of objects; the large seeds here take more.
  const left = await allKeys();
  for (let start = 0; start < left.length; start += 1000) {
    await testEnv.MUSIC.delete(left.slice(start, start + 1000));
  }
  harness.r2Calls.length = 0;
});

afterEach(async () => {
  await resetDriver();
});

interface Existing {
  key: string;
  storedKey: string;
  size: number;
  uploadedAt: string;
}

interface Checked {
  existing: Existing[];
  unchecked: string[];
}

async function check(
  body: unknown,
  on: FilesHarness = harness,
): Promise<{ status: number; body: Checked }> {
  on.r2Calls.length = 0;
  const response = await on.call(owner, "POST", "/files/uploads/check", body);
  return { status: response.status, body: (await response.json()) as Checked };
}

const listings = (on: FilesHarness = harness) =>
  on.r2Calls.filter((call) => call.method === "list");

describe("POST /api/files/uploads/check", () => {
  it("answers the keys that exist, with the stored size and time, in one listing a folder", async () => {
    await seedObjects(["Album/01.flac", "Album/03.lrc", "Album/sub/01.flac", "Other/x.flac"]);
    const stored = await testEnv.MUSIC.head("Album/01.flac");

    const { status, body } = await check({
      keys: ["Album/01.flac", "Album/02.flac", "Album/03.lrc", "Single/04.flac"],
    });

    expect(status).toBe(200);
    expect(body.unchecked).toEqual([]);
    expect(body.existing).toEqual([
      {
        key: "Album/01.flac",
        storedKey: "Album/01.flac",
        size: stored?.size,
        uploadedAt: stored?.uploaded.toISOString(),
      },
      expect.objectContaining({ key: "Album/03.lrc", storedKey: "Album/03.lrc" }),
    ]);
    // One delimited listing per folder, of that folder only.
    expect(listings().map((call) => call.argument)).toEqual([
      { prefix: "Album/", delimiter: "/", limit: 1000, cursor: undefined },
      { prefix: "Single/", delimiter: "/", limit: 1000, cursor: undefined },
    ]);
    expect(harness.r2Calls.every((call) => call.method === "list")).toBe(true);
  });

  it("matches a name stored in NFD when asked in NFC, and the other way round", async () => {
    await seedObjects(["Album/Café.flac".normalize("NFD"), "Album/Noël.flac".normalize("NFC")]);

    const { body } = await check({
      keys: ["Album/Café.flac".normalize("NFC"), "Album/Noël.flac".normalize("NFD")],
    });

    expect(body.existing.map(({ key, storedKey }) => ({ key, storedKey }))).toEqual([
      { key: "Album/Café.flac".normalize("NFC"), storedKey: "Album/Café.flac".normalize("NFD") },
      { key: "Album/Noël.flac".normalize("NFD"), storedKey: "Album/Noël.flac".normalize("NFC") },
    ]);
    expect(body.unchecked).toEqual([]);
  });

  it("lists a folder page after page until every key is found, or the folder ends", async () => {
    const paged = filesHarness(ORIGIN, { listLimit: 2 });
    await seedObjects(["Big/1.flac", "Big/2.flac", "Big/3.flac", "Big/4.flac", "Big/5.flac"]);

    const found = await check({ keys: ["Big/4.flac"] }, paged);
    expect(found.body.existing.map((entry) => entry.key)).toEqual(["Big/4.flac"]);
    // Pages of 2: the key is on the second, and the listing stops there.
    expect(listings(paged)).toHaveLength(2);

    const missing = await check({ keys: ["Big/9.flac"] }, paged);
    expect(missing.body).toEqual({ existing: [], unchecked: [] });
    // Every page, to the folder's end: only then is the key known to be new.
    expect(listings(paged)).toHaveLength(3);
  });

  it("looks for the keys of a large flat folder with head() once its entries are spent", {
    timeout: 60_000,
  }, async () => {
    // More direct entries than a request lists: Big/2000.flac is past them.
    await seedObjects(
      Array.from(
        { length: CHECK_ENTRIES + 1 },
        (_, index) => `Big/${String(index).padStart(4, "0")}.flac`,
      ),
      100,
    );
    await seedObjects(["Other/a.flac"]);

    const { body } = await check({
      keys: ["Big/0000.flac", "Big/2000.flac", "Big/9999.flac", "Other/a.flac"],
    });

    // Found by listing, found by head(), and known new by head().
    expect(body.existing.map(({ key, storedKey }) => [key, storedKey])).toEqual([
      ["Big/0000.flac", "Big/0000.flac"],
      ["Big/2000.flac", "Big/2000.flac"],
      ["Other/a.flac", "Other/a.flac"],
    ]);
    expect(body.unchecked).toEqual([]);
    // Two full pages, exactly the entries allowed, then one head() a key left.
    expect(listings().map((call) => (call.argument as R2ListOptions).limit)).toEqual([1000, 1000]);
    expect(
      harness.r2Calls.filter((call) => call.method === "head").map((call) => call.argument),
    ).toEqual(["Big/2000.flac", "Big/9999.flac", "Other/a.flac"]);
  });

  it("finds a key stored in another spelling with head()", { timeout: 60_000 }, async () => {
    await seedObjects(
      Array.from(
        { length: CHECK_ENTRIES },
        (_, index) => `Big/${String(index).padStart(4, "0")}.flac`,
      ),
      100,
    );
    await seedObjects(["Big/Zoë.flac".normalize("NFD")]);

    const { body } = await check({ keys: ["Big/Zoë.flac".normalize("NFC")] });

    expect(body.existing.map(({ key, storedKey }) => [key, storedKey])).toEqual([
      ["Big/Zoë.flac".normalize("NFC"), "Big/Zoë.flac".normalize("NFD")],
    ]);
    expect(body.unchecked).toEqual([]);
  });

  it("asks each listing for no more than the entries left", { timeout: 60_000 }, async () => {
    await seedObjects(
      Array.from({ length: 1500 }, (_, index) => `Mid/${String(index).padStart(4, "0")}.flac`),
      100,
    );

    const { body } = await check({ keys: ["Mid/9999.flac", "Other/a.flac"] });

    // Mid/ ends on its second page (1,500 entries), so Other/ may list the 500 left.
    expect(body).toEqual({ existing: [], unchecked: [] });
    expect(listings().map((call) => (call.argument as R2ListOptions).limit)).toEqual([
      1000,
      1000,
      CHECK_ENTRIES - 1500,
    ]);
  });

  it("looks past the listings with the calls left, and answers the rest unchecked", async () => {
    await seedObjects([`F${CHECK_LISTINGS + 1}/a.flac`]);
    const keys = Array.from({ length: CHECK_LISTINGS + 10 }, (_, index) => `F${index}/a.flac`);

    const { body } = await check({ keys });

    // 40 folders listed, then a head() each for as many as the CHECK_CALLS (47) calls allow.
    expect(listings()).toHaveLength(CHECK_LISTINGS);
    const heads = harness.r2Calls.filter((call) => call.method === "head");
    expect(heads).toHaveLength(CHECK_CALLS - CHECK_LISTINGS);
    expect(harness.r2Calls).toHaveLength(CHECK_CALLS);
    expect(body.existing.map((entry) => entry.key)).toEqual([`F${CHECK_LISTINGS + 1}/a.flac`]);
    expect(body.unchecked).toEqual(keys.slice(CHECK_CALLS));
  });

  it("does not report a key the upload rules refuse, and lists nothing for it", async () => {
    await seedObjects(["_covers/a.jpg", "Album/notes.pdf"]);

    const { status, body } = await check({
      keys: ["_covers/a.jpg", "Album/notes.pdf", "Album/../x.flac", "/abs.flac", "A/.hidden.flac"],
    });

    expect(status).toBe(200);
    expect(body).toEqual({ existing: [], unchecked: [] });
    expect(harness.r2Calls).toEqual([]);
  });

  it("keeps a listed folder's bytes as given, inside the prefix", async () => {
    const folder = "Björk/".normalize("NFD");
    await seedObjects([`${folder}Début.flac`.normalize("NFD")]);

    const { body } = await check({
      prefix: folder,
      keys: [`${folder}${"Début.flac".normalize("NFC")}`, "Elsewhere/a.flac"],
    });

    expect(body.existing.map((entry) => entry.storedKey)).toEqual([
      `${folder}Début.flac`.normalize("NFD"),
    ]);
    // The key outside the prefix is refused by the rules, so not listed.
    expect(listings().map((call) => (call.argument as R2ListOptions).prefix)).toEqual([folder]);
  });

  it("works where uploads are not configured: it reads only the binding", async () => {
    const unconfigured = filesHarness(ORIGIN);
    await seedObjects(["Album/01.flac"]);

    const { status, body } = await check({ keys: ["Album/01.flac"] }, unconfigured);

    expect(status).toBe(200);
    expect(body.existing.map((entry) => entry.key)).toEqual(["Album/01.flac"]);
  });

  it("answers 400 invalid_request to a body it cannot read, touching nothing", async () => {
    for (const body of [
      {},
      { keys: [] },
      { keys: "Album/01.flac" },
      { keys: [1] },
      { keys: Array.from({ length: CHECK_BATCH + 1 }, (_, index) => `A/${index}.flac`) },
      { keys: ["A/b.flac"], prefix: 3 },
    ]) {
      await expectRefusal(
        harness,
        () => harness.call(owner, "POST", "/files/uploads/check", body),
        400,
        "invalid_request",
      );
    }
    expect(harness.r2Calls).toEqual([]);
  });

  it(`takes ${CHECK_BATCH} keys in one request`, async () => {
    const keys = Array.from({ length: CHECK_BATCH }, (_, index) => `Album/${index}.flac`);

    const { status } = await check({ keys });

    expect(status).toBe(200);
    expect(listings()).toHaveLength(1);
  });

  it("answers 400 invalid_path and 403 reserved_path to a bad prefix, touching nothing", async () => {
    await expectRefusal(
      harness,
      () =>
        harness.call(owner, "POST", "/files/uploads/check", { prefix: "A", keys: ["A/b.flac"] }),
      400,
      "invalid_path",
    );
    await expectRefusal(
      harness,
      () =>
        harness.call(owner, "POST", "/files/uploads/check", {
          prefix: "_covers/",
          keys: ["_covers/b.jpg"],
        }),
      403,
      "reserved_path",
    );
    expect(harness.r2Calls).toEqual([]);
  });

  it("answers 401 without a session, and 403 forbidden to a role without files:write", async () => {
    const body = { keys: ["A/b.flac"] };
    await expectRefusal(
      harness,
      () => harness.call(undefined, "POST", "/files/uploads/check", body),
      401,
      "unauthenticated",
    );
    await expectRefusal(
      harness,
      () => harness.call(guest, "POST", "/files/uploads/check", body),
      403,
      "forbidden",
    );
    expect(harness.r2Calls).toEqual([]);
  });

  it("answers 403 forbidden_origin cross-origin, and to a body that is not JSON", async () => {
    await expectRefusal(
      harness,
      () =>
        harness.call(
          owner,
          "POST",
          "/files/uploads/check",
          { keys: ["A/b.flac"] },
          { origin: "https://evil.test" },
        ),
      403,
      "forbidden_origin",
    );
    await expectRefusal(
      harness,
      () =>
        harness.send(
          new Request(`${ORIGIN}/api/files/uploads/check`, {
            method: "POST",
            headers: { origin: ORIGIN, cookie: owner.header(), "content-type": "text/plain" },
            body: "{}",
          }),
        ),
      403,
      "forbidden_origin",
    );
    expect(harness.r2Calls).toEqual([]);
  });

  it("answers 413 to a body over 1 MiB", async () => {
    await expectRefusal(
      harness,
      () =>
        harness.call(owner, "POST", "/files/uploads/check", {
          keys: ["A/b.flac"],
          padding: "x".repeat(MAX_FILE_CHECK_BODY_BYTES),
        }),
      413,
      "payload_too_large",
    );
    expect(harness.r2Calls).toEqual([]);
  });

  it("answers 403 file_writes_disabled where FILE_WRITES is off, listing nothing", async () => {
    const preview = filesHarness(ORIGIN, { fileWrites: "off", uploads: UPLOADS_ENV });
    await expectRefusal(
      preview,
      () => preview.call(owner, "POST", "/files/uploads/check", { keys: ["A/b.flac"] }),
      403,
      "file_writes_disabled",
    );
    expect(preview.r2Calls).toEqual([]);
  });
});
