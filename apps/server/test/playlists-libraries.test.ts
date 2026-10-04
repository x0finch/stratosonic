import {
  library,
  type Playlist,
  type PlaylistTrack,
  playlist,
  playlistId,
  prefixedId,
  subsonicUser,
  trackId,
} from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { DEFAULT_PLAYLIST_IMPORT_LIMITS, importPlaylists } from "../src/playlists/import";
import { entryCandidates, type PlaylistLibrary } from "../src/playlists/m3u";
import { s3Path } from "../src/storage/s3";
import { deleteSubsonicUser } from "../src/users/delete";
import { bootstrapAdmin } from "./browsing-support";
import { cost, countingD1 } from "./console-auth-support";
import { FakeS3, installFakeS3, libraryTestBucket } from "./fake-s3";
import { ADMIN, afterAuthentication, countingApp, namesALibrary } from "./library-scope-support";
import {
  callPlaylists,
  importCountingWrites,
  importUntilComplete,
  storedEntries,
  storedPlaylists,
} from "./playlists-support";
import {
  ARCHIVE,
  connectLibrary,
  type FakeLibrary,
  installFakeLibrary,
  libraryRow,
  operationsSince,
  resetLibraries,
} from "./scan-libraries-support";
import { seedTrack, seedUser, testEnv } from "./support";

/**
 * Playlists across libraries (#84, "Playlists across libraries"; #150):
 * library 1 is the bound bucket, and library 2 an R2 bucket behind the fake
 * S3 endpoint (test/fake-s3.ts).
 *
 * - The import reads the playlists of every active library. A bare entry
 *   resolves in its playlist's own library; a line that starts with a
 *   library's path (`r2-binding://MUSIC/...`, `s3://<host>/<bucket>/...`)
 *   resolves in that library, Navidrome's absolute-path matching; a path no
 *   active library has resolves to nothing.
 * - A write goes to the playlist's own library: a new playlist to library 1,
 *   an existing one where its file is, refused in a read-only library. Its
 *   own library's tracks are written bare, so a library-1-only file is byte
 *   for byte v0.5.0's, and another library's as `<path>/<key>`.
 * - A file whose id another library's playlist holds is broken, not written.
 */

const L1_ONE = "Alpha/First/01 One.mp3";
const L1_TWO = "Alpha/First/02 Two.mp3";
const L2_ONE = "Beta/Second/01 Uno.flac";
const L2_TWO = "Beta/Second/02 Dos.flac";
/** A key both libraries hold, so two tracks. */
const SHARED = "Gamma/Both/01 Same.mp3";

const BOUND_PATH = "r2-binding://MUSIC";

let installed: FakeLibrary;
let fake: FakeS3;
/** Library 2's path, `s3://<fake host>/archive`. */
let archive: string;

/** A pass that begins after everything the buckets have stamped. */
function later(): Date {
  return new Date(Date.now() + 10 * 60_000);
}

function track(libraryId: number, key: string): string {
  return trackId(libraryId, key);
}

function tr(libraryId: number, key: string): string {
  return prefixedId("track", trackId(libraryId, key));
}

function m3u(lines: readonly string[], name?: string): string {
  return `#EXTM3U\n${name === undefined ? "" : `#PLAYLIST:${name}\n`}${lines.join("\n")}\n`;
}

async function putBound(key: string, text: string): Promise<void> {
  await testEnv.MUSIC.put(key, new TextEncoder().encode(text));
}

async function putArchive(key: string, text: string): Promise<void> {
  await libraryTestBucket().put(key, new TextEncoder().encode(text));
}

async function archiveText(key: string): Promise<string | null> {
  const object = await libraryTestBucket().get(key);
  return object === null ? null : object.text();
}

async function boundText(key: string): Promise<string | null> {
  const object = await testEnv.MUSIC.get(key);
  return object === null ? null : object.text();
}

/** A playlist's row, by its library and key. */
async function rowOf(libraryId: number, key: string): Promise<Playlist | undefined> {
  return (await storedPlaylists()).find((row) => row.id === playlistId(libraryId, key));
}

/** A playlist's entries, in order, as track ids. */
async function entriesOf(libraryId: number, key: string): Promise<string[]> {
  const id = playlistId(libraryId, key);
  return (await storedEntries())
    .filter((entry: PlaylistTrack) => entry.playlistId === id)
    .map((entry) => entry.trackId);
}

async function snapshot() {
  return { playlists: await storedPlaylists(), entries: await storedEntries() };
}

async function adminId(): Promise<string> {
  const [row] = await database(testEnv)
    .select()
    .from(subsonicUser)
    .where(eq(subsonicUser.userName, "admin"));
  return row?.id ?? "";
}

beforeAll(async () => {
  await bootstrapAdmin();
});

beforeEach(async () => {
  await resetLibraries();
  installed = installFakeLibrary();
  fake = installed.fake;
  await connectLibrary(fake);
  archive = s3Path({ endpoint: fake.endpoint, bucket: fake.bucket });
  for (const key of [L1_ONE, L1_TWO, SHARED]) {
    await seedTrack({ r2Key: key, duration: 10 });
  }
  for (const key of [L2_ONE, L2_TWO, SHARED]) {
    await seedTrack({ r2Key: key, libraryId: ARCHIVE.id, duration: 20 });
  }
});

afterEach(() => {
  installed.spy.mockRestore();
});

/* ------------------------------------------------------------ resolution -- */

describe("resolving an entry (entryCandidates)", () => {
  const HOST = "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com";
  const LIBRARIES: readonly PlaylistLibrary[] = [
    { id: 1, path: BOUND_PATH, active: true },
    { id: 2, path: `s3://${HOST}/music`, active: true },
    { id: 3, path: `s3://${HOST}/music-classical`, active: true },
    { id: 4, path: `s3://${HOST}/gone`, active: false },
    { id: 5, path: `s3://${HOST}/music/inner`, active: true },
  ];

  it("resolves a bare entry in the playlist's own library, as v0.5.0 does", () => {
    expect(entryCandidates(2, "playlists/mix.m3u", "Artist/01.mp3", LIBRARIES)).toEqual({
      libraryId: 2,
      keys: ["playlists/Artist/01.mp3", "Artist/01.mp3"],
    });
    expect(entryCandidates(1, "playlists/mix.m3u", "/Artist/01.mp3", LIBRARIES)).toEqual({
      libraryId: 1,
      keys: ["Artist/01.mp3"],
    });
  });

  it("resolves a line that starts with a library's path in that library", () => {
    expect(
      entryCandidates(2, "playlists/mix.m3u", `${BOUND_PATH}/Artist/01.mp3`, LIBRARIES),
    ).toEqual({ libraryId: 1, keys: ["Artist/01.mp3"] });
    expect(
      entryCandidates(1, "playlists/mix.m3u", `s3://${HOST}/music/Artist/01.mp3`, LIBRARIES),
    ).toEqual({ libraryId: 2, keys: ["Artist/01.mp3"] });
  });

  it("matches at a path boundary, and the longest path first", () => {
    expect(
      entryCandidates(1, "m.m3u", `s3://${HOST}/music-classical/Bach/01.mp3`, LIBRARIES),
    ).toEqual({ libraryId: 3, keys: ["Bach/01.mp3"] });
    expect(entryCandidates(1, "m.m3u", `s3://${HOST}/music/inner/01.mp3`, LIBRARIES)).toEqual({
      libraryId: 5,
      keys: ["01.mp3"],
    });
  });

  it("does not take a line whose path only begins with a library's path", () => {
    expect(entryCandidates(1, "m.m3u", `s3://${HOST}/musicbox/01.mp3`, LIBRARIES).libraryId).toBe(
      1,
    );
  });

  it("resolves a path of a library that is not active, or that climbs out of it, to nothing", () => {
    expect(entryCandidates(1, "m.m3u", `s3://${HOST}/gone/Artist/01.mp3`, LIBRARIES)).toEqual({
      libraryId: 4,
      keys: [],
    });
    expect(entryCandidates(1, "m.m3u", `s3://${HOST}/music/../gone/01.mp3`, LIBRARIES)).toEqual({
      libraryId: 2,
      keys: [],
    });
  });

  it("gives a path no library has to the playlist's own library, as v0.5.0 did", () => {
    const resolved = entryCandidates(2, "m.m3u", `s3://${HOST}/elsewhere/01.mp3`, LIBRARIES);
    expect(resolved.libraryId).toBe(2);
    expect(resolved.keys).not.toContain("01.mp3");
  });
});

/* ---------------------------------------------------------------- import -- */

describe("importing from every library", () => {
  const ONE = "playlists/one.m3u";
  const TWO = "playlists/two.m3u";

  beforeEach(async () => {
    await putBound(
      ONE,
      m3u([
        L1_ONE,
        `${archive}/${L2_ONE}`,
        `${archive}/${SHARED}`,
        SHARED,
        `s3://${fake.host}/elsewhere/${L2_ONE}`,
      ]),
    );
    await putArchive(
      TWO,
      m3u([L2_ONE, `${BOUND_PATH}/${L1_TWO}`, SHARED, `/${L2_TWO}`, `${BOUND_PATH}/${L2_ONE}`]),
    );
  });

  it("imports each library's playlists into that library, owned by the first admin", async () => {
    const runs = await importUntilComplete({}, later());

    const one = await rowOf(1, ONE);
    const two = await rowOf(ARCHIVE.id, TWO);
    expect(one).toMatchObject({ libraryId: 1, r2Key: ONE, ownerId: await adminId() });
    expect(two).toMatchObject({ libraryId: ARCHIVE.id, r2Key: TWO, ownerId: await adminId() });
    expect(runs.at(-1)?.totals).toMatchObject({ imported: 2, broken: 0 });
  });

  it("resolves bare lines in the playlist's library and qualified ones in theirs", async () => {
    const runs = await importUntilComplete({}, later());

    expect(await entriesOf(1, ONE)).toEqual([
      track(1, L1_ONE),
      track(ARCHIVE.id, L2_ONE),
      track(ARCHIVE.id, SHARED),
      track(1, SHARED),
    ]);
    expect(await entriesOf(ARCHIVE.id, TWO)).toEqual([
      track(ARCHIVE.id, L2_ONE),
      track(1, L1_TWO),
      track(ARCHIVE.id, SHARED),
      track(ARCHIVE.id, L2_TWO),
    ]);
    // A path no library has, and a library-2 key under library 1's path.
    expect(runs.at(-1)?.totals.unmatched).toBe(2);
    expect((await rowOf(ARCHIVE.id, TWO))?.duration).toBe(70);
  });

  it("writes nothing on a second pass over unchanged buckets", async () => {
    await importUntilComplete({}, later());
    const counted = await importCountingWrites(later());

    expect(counted.run.completed).toBe(true);
    expect(counted.run.counts.unchanged).toBe(2);
    expect(counted.playlistRowsWritten).toBe(0);
  });

  it("looks the entries up with one statement per file, whatever libraries they name", async () => {
    const counted = await importCountingWrites(later());

    expect(counted.run.counts.imported).toBe(2);
    expect(counted.statementsAgainst("track")).toHaveLength(2);
    const lookup = counted.statementsAgainst("track")[0]?.sql ?? "";
    expect(lookup.match(/"library_id" = \?/g)).toHaveLength(2);
  });

  it("makes two playlists of one key in two libraries", async () => {
    await putArchive(ONE, m3u([L2_TWO]));
    await importUntilComplete({}, later());

    expect(playlistId(1, ONE)).not.toBe(playlistId(ARCHIVE.id, ONE));
    expect(await entriesOf(1, ONE)).toHaveLength(4);
    expect(await entriesOf(ARCHIVE.id, ONE)).toEqual([track(ARCHIVE.id, L2_TWO)]);
  });

  it("sweeps a playlist whose file left library 2 from library 2 alone", async () => {
    await importUntilComplete({}, later());
    await libraryTestBucket().delete(TWO);
    await putArchive(ONE, m3u([L2_TWO]));
    await importUntilComplete({}, later());

    expect(await rowOf(ARCHIVE.id, TWO)).toBeUndefined();
    expect(await rowOf(1, ONE)).toBeDefined();
    expect(await rowOf(ARCHIVE.id, ONE)).toBeDefined();
  });

  it("walks no library being removed, and resolves its path to nothing", async () => {
    await database(testEnv)
      .update(library)
      .set({ state: "removing" })
      .where(eq(library.id, ARCHIVE.id));
    const before = fake.calls.length;
    await importUntilComplete({}, later());

    expect(fake.calls.length).toBe(before);
    expect(await rowOf(ARCHIVE.id, TWO)).toBeUndefined();
    expect(await entriesOf(1, ONE)).toEqual([track(1, L1_ONE), track(1, SHARED)]);
  });

  it("resumes a pass in library 2 from the cursor its progress names", async () => {
    for (let index = 0; index < 4; index++) {
      await putArchive(`playlists/extra-${index}.m3u`, m3u([L2_ONE]));
    }
    const runs = await importUntilComplete({ pageSize: 2, importsPerRun: 1 }, later());

    expect(runs.length).toBeGreaterThan(4);
    for (let index = 0; index < 4; index++) {
      expect(await entriesOf(ARCHIVE.id, `playlists/extra-${index}.m3u`)).toEqual([
        track(ARCHIVE.id, L2_ONE),
      ]);
    }
    expect(await entriesOf(ARCHIVE.id, TWO)).toHaveLength(4);
  });

  it("goes on to the next library after skipping one at once", async () => {
    const third = new FakeS3({ accountId: "abcdefabcdefabcdefabcdefabcdef00", bucket: "third" });
    installed.spy.mockRestore();
    installed = { fake, spy: installFakeS3(fake, third) };
    await connectLibrary(third, 3);
    fake.fail("access_denied");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await importUntilComplete({}, later());
    } finally {
      warn.mockRestore();
    }

    // Library 3 is served from the same test bucket, so it holds `TWO` too.
    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBe("auth");
    expect(await rowOf(ARCHIVE.id, TWO)).toBeUndefined();
    expect(await rowOf(3, TWO)).toMatchObject({ libraryId: 3 });
  });

  it("skips an unreachable library at once, and keeps its playlists", async () => {
    await importUntilComplete({}, later());
    const kept = await rowOf(ARCHIVE.id, TWO);
    fake.fail("access_denied");
    await putBound(ONE, m3u([L1_TWO]));
    const before = fake.calls.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let runs: Awaited<ReturnType<typeof importUntilComplete>>;
    try {
      runs = await importUntilComplete({}, later());
    } finally {
      warn.mockRestore();
    }

    expect(operationsSince(fake, before)).toEqual(["ListObjectsV2"]);
    expect(runs.at(-1)?.completed).toBe(true);
    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBe("auth");
    expect(await rowOf(ARCHIVE.id, TWO)).toEqual(kept);
    expect(await entriesOf(1, ONE)).toEqual([track(1, L1_TWO)]);
  });
});

/* -------------------------------------------------- the collision guard -- */

describe("a playlist whose id is another library's (ADR-0009)", () => {
  const KEY = "playlists/mix.m3u";
  /** A library-1 key that hashes to library 2's `KEY`. */
  const CRAFTED = `2​${KEY}`;

  it("is the same id, which the guard refuses to move", () => {
    expect(playlistId(1, CRAFTED)).toBe(playlistId(ARCHIVE.id, KEY));
  });

  it("leaves library 1's playlist and entries alone, and counts library 2's broken", async () => {
    await putBound(CRAFTED, m3u([L1_ONE, L1_TWO]));
    await importUntilComplete({}, later());
    const before = await snapshot();

    await putArchive(KEY, m3u([L2_ONE]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let runs: Awaited<ReturnType<typeof importUntilComplete>>;
    let warnings: unknown[][];
    try {
      runs = await importUntilComplete({}, later());
    } finally {
      warnings = [...warn.mock.calls];
      warn.mockRestore();
    }

    expect(await snapshot()).toEqual(before);
    expect(await entriesOf(1, CRAFTED)).toEqual([track(1, L1_ONE), track(1, L1_TWO)]);
    expect(runs.at(-1)?.totals).toMatchObject({ broken: 1, imported: 1 });
    expect(warnings.some(([message]) => String(message).includes("another library"))).toBe(true);
  });

  it("leaves library 2's playlist alone when library 1's crafted key comes later", async () => {
    await putArchive(KEY, m3u([L2_ONE, L2_TWO]));
    await importUntilComplete({}, later());
    const before = await snapshot();
    expect(await entriesOf(ARCHIVE.id, KEY)).toHaveLength(2);

    await putBound(CRAFTED, m3u([L1_ONE]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let runs: Awaited<ReturnType<typeof importUntilComplete>>;
    try {
      runs = await importUntilComplete({}, later());
    } finally {
      warn.mockRestore();
    }

    expect(await snapshot()).toEqual(before);
    expect(runs.at(-1)?.totals).toMatchObject({ broken: 1, imported: 1 });
  });
});

/* ---------------------------------------------------------------- writes -- */

describe("a client playlist across libraries", () => {
  it("writes its own library's tracks bare and the others' qualified", async () => {
    const created = await callPlaylists("createPlaylist", [
      ["name", "Mixed"],
      ["songId", tr(1, L1_ONE)],
      ["songId", tr(ARCHIVE.id, L2_ONE)],
      ["songId", tr(1, L1_TWO)],
      ["songId", tr(ARCHIVE.id, SHARED)],
    ]);
    expect(created.status).toBe("ok");
    const [row] = await storedPlaylists();

    expect(row?.libraryId).toBe(1);
    expect(await boundText(row?.r2Key ?? "")).toBe(
      m3u([L1_ONE, `${archive}/${L2_ONE}`, L1_TWO, `${archive}/${SHARED}`], "Mixed"),
    );
  });

  it("round-trips: the next import produces the identical row and entries", async () => {
    await callPlaylists("createPlaylist", [
      ["name", "Mixed"],
      ["songId", tr(ARCHIVE.id, L2_ONE)],
      ["songId", tr(1, SHARED)],
      ["songId", tr(ARCHIVE.id, SHARED)],
    ]);
    const before = await snapshot();

    const counted = await importCountingWrites(later());

    expect(counted.run.counts).toMatchObject({ imported: 1, unchanged: 1, unmatched: 0 });
    expect(counted.playlistRowsWritten).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("writes a library-1-only playlist byte for byte as v0.5.0, reading no library", async () => {
    const { d1, call } = countingApp();
    await call(ADMIN, "ping");
    d1.reset();
    const created = await call(ADMIN, "createPlaylist", [
      ["name", "Plain"],
      ["songId", tr(1, L1_ONE)],
      ["songId", tr(1, L1_TWO)],
    ]);
    expect(created.status).toBe("ok");
    const [row] = await storedPlaylists();

    expect(await boundText(row?.r2Key ?? "")).toBe(
      "#EXTM3U\n#PLAYLIST:Plain\nAlpha/First/01 One.mp3\nAlpha/First/02 Two.mp3\n",
    );
    expect(namesALibrary(afterAuthentication(d1.statements))).toBe(false);
  });
});

describe("writing a library-2 playlist", () => {
  const KEY = "playlists/two.m3u";
  let id = "";

  beforeEach(async () => {
    await putArchive(KEY, m3u([L2_ONE, `${BOUND_PATH}/${L1_ONE}`], "Two"));
    await importUntilComplete({}, later());
    id = prefixedId("playlist", playlistId(ARCHIVE.id, KEY));
  });

  it("puts its file in library 2's bucket, and writes its row there", async () => {
    const before = fake.calls.length;
    const updated = await callPlaylists("updatePlaylist", [
      ["playlistId", id],
      ["songIdToAdd", tr(1, L1_TWO)],
      ["songIdToAdd", tr(ARCHIVE.id, L2_TWO)],
      ["songIndexToRemove", "0"],
    ]);

    expect(updated.status).toBe("ok");
    expect(operationsSince(fake, before)).toEqual(["PutObject"]);
    expect(await archiveText(KEY)).toBe(
      m3u([`${BOUND_PATH}/${L1_ONE}`, `${BOUND_PATH}/${L1_TWO}`, L2_TWO], "Two"),
    );
    expect(await boundText(KEY)).toBeNull();
    expect(await entriesOf(ARCHIVE.id, KEY)).toEqual([
      track(1, L1_ONE),
      track(1, L1_TWO),
      track(ARCHIVE.id, L2_TWO),
    ]);
    expect((await rowOf(ARCHIVE.id, KEY))?.libraryId).toBe(ARCHIVE.id);
  });

  it("is not written again by the next import, though S3 dated it to the second", async () => {
    await callPlaylists("updatePlaylist", [
      ["playlistId", id],
      ["songIdToAdd", tr(ARCHIVE.id, L2_TWO)],
    ]);
    const before = await snapshot();
    const stored = (await rowOf(ARCHIVE.id, KEY))?.changedAt.getTime() ?? 1;
    expect(stored % 1000).toBe(0);

    const counted = await importCountingWrites(later());

    expect(counted.run.counts.unchanged).toBe(1);
    expect(counted.playlistRowsWritten).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("is refused in a read-only library, with nothing put or written", async () => {
    await database(testEnv)
      .update(library)
      .set({ writable: false })
      .where(eq(library.id, ARCHIVE.id));
    const before = await snapshot();
    const calls = fake.calls.length;
    const READ_ONLY = { code: 0, message: "the library is read-only" };

    expect(
      (
        await callPlaylists("updatePlaylist", [
          ["playlistId", id],
          ["name", "Renamed"],
          ["songIdToAdd", tr(1, L1_TWO)],
        ])
      ).error,
    ).toEqual(READ_ONLY);
    expect((await callPlaylists("deletePlaylist", [["id", id]])).error).toEqual(READ_ONLY);
    expect(
      (
        await callPlaylists("createPlaylist", [
          ["playlistId", id],
          ["songId", tr(1, L1_TWO)],
        ])
      ).error,
    ).toEqual(READ_ONLY);

    expect(await snapshot()).toEqual(before);
    expect(fake.calls.length).toBe(calls);
    expect(await archiveText(KEY)).toBe(m3u([L2_ONE, `${BOUND_PATH}/${L1_ONE}`], "Two"));
  });

  it("costs one D1 round trip more than a library-1 edit: its library row and paths", async () => {
    await putBound("playlists/one.m3u", m3u([L1_ONE], "One"));
    await importUntilComplete({}, later());
    const one = prefixedId("playlist", playlistId(1, "playlists/one.m3u"));
    const { d1, call } = countingApp();
    await call(ADMIN, "ping");

    const tripsOf = async (playlist: string, song: string) => {
      d1.reset();
      const updated = await call(ADMIN, "updatePlaylist", [
        ["playlistId", playlist],
        ["songIdToAdd", song],
      ]);
      expect(updated.status).toBe("ok");
      return cost(afterAuthentication(d1.statements)).roundTrips;
    };

    const inOne = await tripsOf(one, tr(1, L1_TWO));
    const inTwo = await tripsOf(id, tr(ARCHIVE.id, L2_TWO));
    // The playlist, its entries, the songs added, and its batch.
    expect(inOne).toBe(4);
    expect(inTwo).toBe(inOne + 1);
  });

  it("deletes its file from library 2, then its row", async () => {
    const before = fake.calls.length;

    expect((await callPlaylists("deletePlaylist", [["id", id]])).status).toBe("ok");

    expect(operationsSince(fake, before)).toEqual(["DeleteObjects"]);
    expect(await archiveText(KEY)).toBeNull();
    expect(await rowOf(ARCHIVE.id, KEY)).toBeUndefined();
  });

  it("keeps its row when library 2 fails the delete", async () => {
    fake.fail("server_error", ["DeleteObjects", "DeleteObject"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await callPlaylists("deletePlaylist", [["id", id]])).status).toBe("failed");
    } finally {
      error.mockRestore();
    }

    expect(await rowOf(ARCHIVE.id, KEY)).toBeDefined();
    expect(await archiveText(KEY)).not.toBeNull();
  });
});

/* ----------------------------------------------------------------- users -- */

describe("deleting a Subsonic user", () => {
  const ONE = "playlists/bob-one.m3u";
  const TWO = "playlists/bob-two.m3u";
  let bobId = "";

  beforeEach(async () => {
    bobId = await seedUser(`bob-${crypto.randomUUID().slice(0, 8)}`, "builder");
    await putBound(ONE, m3u([L1_ONE]));
    await putArchive(TWO, m3u([L2_ONE]));
    await importUntilComplete({}, later());
    await database(testEnv).update(playlist).set({ ownerId: bobId });
  });

  it("erases their playlist files in both libraries, then the rows", async () => {
    const before = fake.calls.length;

    expect(await deleteSubsonicUser(testEnv, database(testEnv), bobId)).toBeNull();

    expect(operationsSince(fake, before)).toEqual(["DeleteObjects"]);
    expect(await boundText(ONE)).toBeNull();
    expect(await archiveText(TWO)).toBeNull();
    expect(await storedPlaylists()).toEqual([]);
  });

  it("keeps every row when library 2 fails the delete", async () => {
    fake.fail("server_error", ["DeleteObjects", "DeleteObject"]);
    const before = await snapshot();

    await expect(deleteSubsonicUser(testEnv, database(testEnv), bobId)).rejects.toThrow();

    expect(await snapshot()).toEqual(before);
    expect(await archiveText(TWO)).not.toBeNull();
  });

  it("leaves the files of a read-only library, and still deletes the rows", async () => {
    await database(testEnv)
      .update(library)
      .set({ writable: false })
      .where(eq(library.id, ARCHIVE.id));
    const before = fake.calls.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await deleteSubsonicUser(testEnv, database(testEnv), bobId)).toBeNull();
    } finally {
      warn.mockRestore();
    }

    expect(fake.calls.length).toBe(before);
    expect(await boundText(ONE)).toBeNull();
    expect(await archiveText(TWO)).not.toBeNull();
    expect(await storedPlaylists()).toEqual([]);
  });
});

/* ---------------------------------------------------------------- budget -- */

describe("an import step's subrequests", () => {
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

  /** Every step of a pass with the production limits, and what each made. */
  async function countedPass(now: Date) {
    const steps: { total: number; fetches: number; completed: boolean }[] = [];
    for (let step = 0; step < 60; step++) {
      const d1 = countingD1(testEnv.DB);
      const binding: string[] = [];
      const env: Env = {
        ...testEnv,
        DB: d1.binding,
        MUSIC: countingBinding(testEnv.MUSIC, binding),
      };
      const before = fake.calls.length;
      const run = await importPlaylists(env, now, DEFAULT_PLAYLIST_IMPORT_LIMITS, {
        writeBudget: 0,
      });
      const fetches = fake.calls.length - before;
      steps.push({
        total: cost(d1.statements).roundTrips + binding.length + fetches,
        fetches,
        completed: run.completed,
      });
      if (run.completed) {
        return steps;
      }
    }
    throw new Error("the import never completed");
  }

  beforeEach(async () => {
    for (let index = 0; index < 25; index++) {
      const name = String(index).padStart(2, "0");
      await putBound(`playlists/one-${name}.m3u`, m3u([L1_ONE, `${archive}/${L2_ONE}`]));
      await putArchive(`playlists/two-${name}.m3u`, m3u([L2_ONE, `${BOUND_PATH}/${L1_ONE}`]));
    }
  });

  it("stays within 42 a step on a first pass and an unchanged one, both libraries", async () => {
    const first = await countedPass(later());
    const unchanged = await countedPass(later());

    for (const step of [...first, ...unchanged]) {
      expect(step.total).toBeLessThanOrEqual(42);
      expect(step.fetches).toBeLessThanOrEqual(21);
    }
    expect(first.length).toBeGreaterThan(1);
    expect((await storedPlaylists()).length).toBe(50);
  });
});
