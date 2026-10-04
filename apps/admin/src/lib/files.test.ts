import { type InfiniteData, InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  type DeleteFolderResult,
  deleteFiles,
  deleteFolderRound,
  type FolderListing,
  fetchFiles,
  type ScanSchedule,
  type ServerClock,
} from "@/lib/api";
import { describeError } from "@/lib/errors";
import {
  afterFilesChange,
  afterUploadsLanded,
  checkFolderName,
  countOf,
  type DeleteTarget,
  deleteConsequences,
  deletedTitle,
  deleteTitle,
  describeListing,
  filesConfigQuery,
  filesLibrary,
  filesSearch,
  folderPath,
  folderQuery,
  folderTrail,
  latestView,
  leaveFolder,
  libraryWrites,
  listedNames,
  NO_SELECTION,
  planDelete,
  reopenFolder,
  reservedPrefixesOf,
  runDelete,
  scanActive,
  scanLine,
  selectedIn,
  selectionWhere,
  shownIds,
  toggleSelected,
  validateFilesSearch,
  viewOfLive,
  viewOfWrite,
} from "@/lib/files";
import type { LiveRead } from "@/lib/overview";

const LIMITS = { maxKeyBytes: 1024, maxSegmentBytes: 255 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function file(key: string): DeleteTarget {
  return { type: "file", key, name: key.split("/").at(-1) ?? key };
}

function folder(prefix: string): DeleteTarget {
  return { type: "folder", prefix, name: folderTrail(prefix).at(-1)?.name ?? "" };
}

describe("the folder path", () => {
  it("lists each folder from the root with its own prefix", () => {
    expect(folderTrail("")).toEqual([]);
    expect(folderTrail("Artist/Album/CD1/")).toEqual([
      { name: "Artist", prefix: "Artist/" },
      { name: "Album", prefix: "Artist/Album/" },
      { name: "CD1", prefix: "Artist/Album/CD1/" },
    ]);
  });

  it("names a folder in a toast by its path without the final slash", () => {
    expect(folderPath("Artist/Album/")).toBe("Artist/Album");
  });

  it("takes a folder from ?prefix=, and the root for anything else", () => {
    expect(validateFilesSearch({})).toEqual({});
    expect(validateFilesSearch({ prefix: "" })).toEqual({});
    expect(validateFilesSearch({ prefix: null })).toEqual({});
    expect(validateFilesSearch({ prefix: {} })).toEqual({});
    expect(validateFilesSearch({ prefix: Number.NaN })).toEqual({});
    expect(validateFilesSearch({ prefix: "Artist/Album/" })).toEqual({ prefix: "Artist/Album/" });
    expect(validateFilesSearch({ prefix: "Artist/Album" })).toEqual({ prefix: "Artist/Album/" });
  });

  it("takes back a folder name the router parsed as JSON: ?prefix=2024 is 2024/", () => {
    expect(validateFilesSearch({ prefix: 2024 })).toEqual({ prefix: "2024/" });
    expect(validateFilesSearch({ prefix: true })).toEqual({ prefix: "true/" });
  });

  it("takes a library from ?library=, absent for library 1 and anything that names none", () => {
    expect(validateFilesSearch({ library: 2, prefix: "A/" })).toEqual({ library: 2, prefix: "A/" });
    expect(validateFilesSearch({ library: "3" })).toEqual({ library: 3 });
    for (const library of [1, "1", 0, -2, 1.5, "2a", "", null, true, {}, Number.NaN, 2 ** 60]) {
      expect(validateFilesSearch({ library })).toEqual({});
    }
  });

  it("links a folder of a library, with no search for library 1's root", () => {
    expect(filesSearch(1, "")).toEqual({});
    expect(filesSearch(1, "A/")).toEqual({ prefix: "A/" });
    expect(filesSearch(2, "")).toEqual({ library: 2 });
    expect(filesSearch(2, "A/")).toEqual({ library: 2, prefix: "A/" });
  });
});

describe("a library on the Files page", () => {
  const CONFIG = {
    writes: { enabled: true },
    libraries: [
      {
        id: 1,
        name: "Music Library",
        writable: true,
        uploads: { configured: false as const, missing: ["R2_ACCESS_KEY_ID"] },
        reservedPrefixes: ["_covers/"],
      },
      {
        id: 2,
        name: "Archive",
        writable: false,
        uploads: { configured: true as const },
        reservedPrefixes: [],
      },
      {
        id: 3,
        name: "Live",
        writable: true,
        uploads: { configured: true as const },
        reservedPrefixes: [],
      },
    ],
  };

  it("finds a library in the configuration", () => {
    expect(filesLibrary(CONFIG, 2)?.name).toBe("Archive");
    expect(filesLibrary(CONFIG, 9)).toBeUndefined();
    expect(filesLibrary(undefined, 1)).toBeUndefined();
  });

  it("writes where the library takes writes, and uploads where they are configured too", () => {
    expect(libraryWrites(CONFIG, 1)).toEqual({
      writable: true,
      uploads: false,
      readOnly: false,
      uploadsMissing: true,
    });
    expect(libraryWrites(CONFIG, 2)).toEqual({
      writable: false,
      uploads: false,
      readOnly: true,
      uploadsMissing: false,
    });
    expect(libraryWrites(CONFIG, 3)).toEqual({
      writable: true,
      uploads: true,
      readOnly: false,
      uploadsMissing: false,
    });
    // Writes off on the deployment: no library takes any, and none reads as read-only.
    expect(libraryWrites({ ...CONFIG, writes: { enabled: false } }, 3)).toEqual({
      writable: false,
      uploads: false,
      readOnly: false,
      uploadsMissing: false,
    });
    // A library the server does not list, or no configuration yet: nothing.
    expect(libraryWrites(CONFIG, 9).writable).toBe(false);
    expect(libraryWrites(undefined, 1).writable).toBe(false);
  });

  it("reserves library 1's _covers/ only", () => {
    expect(reservedPrefixesOf(CONFIG, 1)).toEqual(["_covers/"]);
    expect(reservedPrefixesOf(CONFIG, 3)).toEqual([]);
    expect(reservedPrefixesOf(undefined, 1)).toEqual(["_covers/"]);
    expect(reservedPrefixesOf(undefined, 2)).toEqual([]);
  });
});

describe("the folder section's description", () => {
  it("counts the loaded folders and files, leaving out an empty kind", () => {
    expect(describeListing(2, 12, false)).toBe("2 folders and 12 files");
    expect(describeListing(1, 1, false)).toBe("1 folder and 1 file");
    expect(describeListing(0, 3, false)).toBe("3 files");
    expect(describeListing(4, 0, false)).toBe("4 folders");
    expect(describeListing(0, 1000, true)).toBe("1,000 files so far");
  });
});

describe("a New folder name", () => {
  it("answers the folder's prefix under the one open, trimmed and in NFC", () => {
    expect(checkFolderName("  CD2 ", "Artist/Album/", LIMITS)).toEqual({
      prefix: "Artist/Album/CD2/",
    });
    expect(checkFolderName("Beyoncé", "", LIMITS)).toEqual({ prefix: "Beyoncé/" });
  });

  it("refuses what the server refuses for a new key's segment", () => {
    for (const name of ["", "   ", "a/b", ".hidden", "..", "back\\slash", "tab\there"]) {
      expect(checkFolderName(name, "", LIMITS)).toHaveProperty("error");
    }
  });

  it("counts lengths in bytes of UTF-8", () => {
    // 85 three-byte characters are 255 bytes; 86 are 258.
    expect(checkFolderName("音".repeat(85), "", LIMITS)).toEqual({ prefix: `${"音".repeat(85)}/` });
    expect(checkFolderName("音".repeat(86), "", LIMITS)).toEqual({
      error: "The name is too long: at most 255 bytes.",
    });
    const deep = `${"a".repeat(250)}/`.repeat(4);
    expect(checkFolderName("b".repeat(20), deep, LIMITS)).toEqual({
      error: "The folder's path would be too long: at most 1,024 bytes.",
    });
  });

  it("keeps _covers at the root for the scanner", () => {
    expect(checkFolderName("_covers", "", LIMITS)).toEqual({
      error: "_covers is the scanner's own folder.",
    });
    expect(checkFolderName("_covers", "Artist/", LIMITS)).toEqual({ prefix: "Artist/_covers/" });
  });

  it("allows _covers in a connected library, which reserves nothing", () => {
    expect(checkFolderName("_covers", "", LIMITS, [])).toEqual({ prefix: "_covers/" });
  });
});

describe("planning a delete", () => {
  it("chunks the files into requests of at most 250 keys", () => {
    const targets = Array.from({ length: 600 }, (_, index) => file(`A/${index}.flac`));
    const plan = planDelete(targets, 250);

    expect(plan.fileBatches.map((batch) => batch.length)).toEqual([250, 250, 100]);
    expect(plan.fileBatches.flat()).toEqual(targets.map((t) => (t.type === "file" ? t.key : "")));
    expect(plan.folders).toEqual([]);
  });

  it("sends the folders one after another, apart from the files", () => {
    const plan = planDelete(
      [folder("A/B/"), file("A/1.flac"), folder("A/C/"), file("A/1.flac")],
      250,
    );

    expect(plan).toEqual({ fileBatches: [["A/1.flac"]], folders: ["A/B/", "A/C/"] });
  });

  it("makes no request for nothing", () => {
    expect(planDelete([], 250)).toEqual({ fileBatches: [], folders: [] });
  });
});

const CLOCK: ServerClock = { serverTime: "2026-10-02T12:00:00.000Z", receivedAt: 1_000 };
const SCHEDULED: ScanSchedule = {
  scheduledAt: "2026-10-02T12:02:00.000Z",
  afterCurrentPass: false,
};
const AFTER: ScanSchedule = { scheduledAt: null, afterCurrentPass: true };

describe("running a delete", () => {
  it("loops each folder until done, after the files, and counts as it goes", async () => {
    const rounds: Record<string, DeleteFolderResult[]> = {
      "A/B/": [
        { deleted: 2000, done: false, scan: SCHEDULED, clock: CLOCK },
        { deleted: 532, done: true, scan: AFTER, clock: CLOCK },
      ],
      "A/C/": [{ deleted: 3, done: true, scan: SCHEDULED, clock: CLOCK }],
    };
    const calls: string[] = [];
    const progress: number[] = [];
    const outcome = await runDelete(
      { fileBatches: [["A/1.flac", "A/2.flac"]], folders: ["A/B/", "A/C/"] },
      {
        deleteFiles: async (keys) => {
          calls.push(`files:${keys.length}`);
          return { deleted: keys.length, scan: SCHEDULED, clock: CLOCK };
        },
        deleteFolderRound: async (prefix) => {
          calls.push(`folder:${prefix}`);
          const next = rounds[prefix]?.shift();
          if (!next) {
            throw new Error("called after done");
          }
          return next;
        },
      },
      (deleted) => progress.push(deleted),
    );

    expect(calls).toEqual(["files:2", "folder:A/B/", "folder:A/B/", "folder:A/C/"]);
    expect(progress).toEqual([2, 2002, 2534, 2537]);
    expect(outcome).toEqual({
      files: 2,
      folders: [
        { prefix: "A/B/", deleted: 2532 },
        { prefix: "A/C/", deleted: 3 },
      ],
      schedule: { scan: SCHEDULED, clock: CLOCK },
      reached: ["A/1.flac", "A/2.flac", "A/B/", "A/C/"],
    });
  });

  it("keeps the previous round's schedule when a round has no scan", async () => {
    const later = { ...CLOCK, receivedAt: 2_000 };
    const rounds: DeleteFolderResult[] = [
      { deleted: 2000, done: false, scan: AFTER, clock: CLOCK },
      { deleted: 0, done: true, clock: later },
    ];
    const outcome = await runDelete(
      { fileBatches: [], folders: ["A/"] },
      {
        deleteFiles: () => Promise.reject(new Error("no files")),
        deleteFolderRound: async () => rounds.shift() as DeleteFolderResult,
      },
    );

    expect(outcome.schedule).toEqual({ scan: AFTER, clock: CLOCK });
  });

  it("says nothing of the scan when no round deleted anything", async () => {
    const outcome = await runDelete(
      { fileBatches: [], folders: ["Gone/"] },
      {
        deleteFiles: () => Promise.reject(new Error("no files")),
        deleteFolderRound: async () => ({ deleted: 0, done: true, clock: CLOCK }),
      },
    );

    expect(outcome).toEqual({
      files: 0,
      folders: [{ prefix: "Gone/", deleted: 0 }],
      schedule: undefined,
      reached: ["Gone/"],
    });
  });

  it("takes scan: null as the latest word, the driver not told", async () => {
    const outcome = await runDelete(
      { fileBatches: [["a"], ["b"]], folders: [] },
      {
        deleteFiles: async (keys) => ({
          deleted: 1,
          scan: keys[0] === "a" ? SCHEDULED : null,
          clock: CLOCK,
        }),
        deleteFolderRound: () => Promise.reject(new Error("no folders")),
      },
    );

    expect(outcome.schedule).toEqual({ scan: null, clock: CLOCK });
  });

  it("stops at a failed request and says how far it got", async () => {
    const refused = new ApiError(403, "file_writes_disabled", "");
    const outcome = await runDelete(
      { fileBatches: [["a"], ["b"]], folders: ["F/"] },
      {
        deleteFiles: async (keys) => {
          if (keys[0] === "b") {
            throw refused;
          }
          return { deleted: 1, scan: SCHEDULED, clock: CLOCK };
        },
        deleteFolderRound: () => Promise.reject(new Error("not reached")),
      },
    );

    expect(outcome).toEqual({
      files: 1,
      folders: [],
      schedule: { scan: SCHEDULED, clock: CLOCK },
      reached: ["a"],
      error: refused,
    });
  });

  it("is not done with a folder a failure stopped part way", async () => {
    const ended = new ApiError(401, "unauthenticated", "");
    let round = 0;
    const outcome = await runDelete(
      { fileBatches: [["a"]], folders: ["F/", "G/"] },
      {
        deleteFiles: async () => ({ deleted: 1, scan: SCHEDULED, clock: CLOCK }),
        deleteFolderRound: async () => {
          round += 1;
          if (round === 2) {
            throw ended;
          }
          return { deleted: 2000, done: false, scan: SCHEDULED, clock: CLOCK };
        },
      },
    );

    expect(outcome.reached).toEqual(["a"]);
    expect(outcome.folders).toEqual([{ prefix: "F/", deleted: 2000 }]);
    expect(outcome.error).toBe(ended);
  });
});

describe("the selection", () => {
  /** A folder of 306 files, 300 on its first page and 6 on the next. */
  const keys = Array.from({ length: 306 }, (_, index) => `A/${index}.flac`);
  const firstPage = new Set(keys.slice(0, 300));
  const bothPages = new Set(keys);

  it("counts, checks and deletes only the rows on screen", () => {
    // Every row of both pages selected, then the folder cut back to page 1
    // (left and returned to, after a delete, or after a refused cursor).
    const selection = toggleSelected(NO_SELECTION, "A/", keys.map(file), true);
    expect(selectedIn(selection, "A/", bothPages).size).toBe(306);

    const onScreen = selectedIn(selection, "A/", firstPage);
    expect(onScreen.size).toBe(300);
    expect([...onScreen.keys()].some((id) => !firstPage.has(id))).toBe(false);
    // What a delete would take: the plan has only rows on screen.
    expect(planDelete([...onScreen.values()], 250).fileBatches.flat()).toEqual(keys.slice(0, 300));
  });

  it("is its folder's alone, and starts afresh in another", () => {
    const inA = toggleSelected(NO_SELECTION, "A/", [file("A/0.flac")], true);
    expect(selectedIn(inA, "B/", bothPages).size).toBe(0);

    const inB = toggleSelected(inA, "B/", [file("B/x.flac")], true);
    expect([...inB.targets.keys()]).toEqual(["B/x.flac"]);
    expect(toggleSelected(inB, "B/", [file("B/x.flac")], false).targets.size).toBe(0);
  });

  it("holds nothing once the page has left its folder", () => {
    // The page sets NO_SELECTION when it leaves a folder: a return finds
    // nothing selected, even rows that are shown again.
    expect(selectedIn(NO_SELECTION, "A/", bothPages).size).toBe(0);
    expect(NO_SELECTION.prefix).toBeNull();
  });

  it("keeps only the ids a test lets through", () => {
    const selection = new Map([
      ["A/", folder("A/")],
      ["a.flac", file("a.flac")],
      ["b.flac", file("b.flac")],
    ]);
    const done = new Set(["A/", "a.flac"]);

    expect([...selectionWhere(selection, (id) => !done.has(id)).keys()]).toEqual(["b.flac"]);
    // The original is left as it was.
    expect(selection.size).toBe(3);
  });

  it("knows which rows a folder's loaded pages show", () => {
    const shown = shownIds({
      pages: [
        { prefix: "", folders: [{ name: "A", prefix: "A/" }], files: [], cursor: "c" },
        page("b.flac", null),
      ],
      pageParams: [null, "c"],
    });

    expect([...shown]).toEqual(["A/", "b.flac"]);
    expect(shownIds(undefined).size).toBe(0);
  });
});

describe("the delete dialog's words", () => {
  it("titles the dialog with what goes", () => {
    expect(deleteTitle([file("a"), file("b"), file("c"), folder("F/")])).toBe(
      "Delete 3 files and 1 folder?",
    );
    expect(deleteTitle([file("a")])).toBe("Delete 1 file?");
    expect(deleteTitle([folder("A/"), folder("B/")])).toBe("Delete 2 folders?");
  });

  it("lists up to five names, folders with their slash, and how many more", () => {
    const targets = [folder("Art/"), ...Array.from({ length: 16 }, (_, i) => file(`${i}.flac`))];
    expect(listedNames(targets)).toEqual({
      names: ["Art/", "0.flac", "1.flac", "2.flac", "3.flac"],
      more: 12,
    });
    expect(listedNames([file("a.flac")])).toEqual({ names: ["a.flac"], more: 0 });
  });

  it("says the delete cannot be undone, and when tracks leave the library", () => {
    expect(deleteConsequences(120)).toBe(
      "This cannot be undone. Tracks leave the library at the next scan, about 2 minutes after your last change.",
    );
    expect(deleteConsequences(60)).toContain("about a minute after");
  });

  it("toasts what was deleted", () => {
    expect(deletedTitle({ files: 4, folders: [] })).toBe("Deleted 4 files");
    expect(deletedTitle({ files: 1, folders: [] })).toBe("Deleted 1 file");
    expect(deletedTitle({ files: 0, folders: [{ prefix: "Artist/Album/", deleted: 532 }] })).toBe(
      "Deleted Artist/Album (532 files)",
    );
    expect(
      deletedTitle({
        files: 4,
        folders: [
          { prefix: "A/", deleted: 1000 },
          { prefix: "B/", deleted: 64 },
        ],
      }),
    ).toBe("Deleted 4 files and 2 folders (1,064 files)");
    expect(countOf(2000, "file")).toBe("2,000 files");
  });
});

describe("the scan line", () => {
  const server = Date.parse(CLOCK.serverTime);
  const at = (offsetMs: number): ScanSchedule => ({
    scheduledAt: new Date(server + offsetMs).toISOString(),
    afterCurrentPass: false,
  });
  const write = (scan: ScanSchedule | null, clock = CLOCK) => viewOfWrite({ scan, clock });

  it("counts down to the pass on the server's clock", () => {
    // Read 30 s after the answer arrived, by this browser's clock, whatever it says.
    const now = CLOCK.receivedAt + 30_000;
    expect(scanLine(write(at(150_000)), now)).toEqual({
      badge: "Scan scheduled",
      text: "Library scan in about 2 minutes.",
    });
    expect(scanLine(write(at(90_000)), now)?.text).toBe("Library scan in about a minute.");
    expect(scanLine(write(at(30_000)), now)?.text).toBe("Library scan starting.");
    expect(scanLine(write(at(-5_000)), now)?.text).toBe("Library scan starting.");
  });

  it("says a scan is running, and whether another follows it", () => {
    expect(scanLine(write(AFTER), 0)).toEqual({
      badge: "Scanning",
      text: "A scan is running. Another follows it for your recent changes.",
    });
    expect(scanLine(write({ scheduledAt: null, afterCurrentPass: false }), 0)).toEqual({
      badge: "Scanning",
      text: "A scan is running.",
    });
  });

  it("is absent with no pass scheduled or running", () => {
    expect(scanLine(undefined, 0)).toBeNull();
    expect(scanLine(write(null), 0)).toBeNull();
    expect(scanActive(write(null))).toBe(false);
    expect(scanActive(undefined)).toBe(false);
  });

  it("follows the live route: a running pass, or none", () => {
    const live = (
      running: boolean,
      scheduled: ScanSchedule | null,
      receivedAt: number,
    ): LiveRead => ({
      scan: {
        running,
        phase: running ? "scan" : null,
        progress: null,
        estimatedTotal: null,
        last: null,
        scheduled,
      },
      nowPlaying: null,
      serverTime: CLOCK.serverTime,
      receivedAt,
    });
    expect(scanLine(viewOfLive(live(true, null, 5)), 5)?.text).toBe("A scan is running.");
    expect(scanLine(viewOfLive(live(false, null, 5)), 5)).toBeNull();
    expect(scanActive(viewOfLive(live(true, null, 5)))).toBe(true);
  });

  it("takes whichever answer arrived last", () => {
    const older = write(at(120_000), { ...CLOCK, receivedAt: 1 });
    const newer = write(null, { ...CLOCK, receivedAt: 2 });
    expect(latestView(older, newer)).toBe(newer);
    expect(latestView(newer, older)).toBe(newer);
    expect(latestView(undefined, older)).toBe(older);
    expect(latestView()).toBeUndefined();
  });
});

describe("describeError for the Files API", () => {
  it("has words for every refusal #83 lists", () => {
    for (const code of [
      "invalid_path",
      "reserved_path",
      "file_writes_disabled",
      "invalid_cursor",
      "uploads_not_configured",
      "type_not_allowed",
      "too_large",
      "empty_file",
      "exists",
      "path_too_long",
    ]) {
      expect(describeError(new ApiError(400, code, "")).title).not.toBe("Something went wrong");
    }
  });
});

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("the Files API client", () => {
  it("lists a folder of a library by prefix and cursor", async () => {
    const fetch = answer(200, { prefix: "A B/", folders: [], files: [], cursor: null });

    await fetchFiles(1, "A B/", "c&1");

    expect(fetch).toHaveBeenCalledWith(
      "/api/files?library=1&prefix=A+B%2F&cursor=c%261",
      expect.anything(),
    );
    await fetchFiles(2, "");
    expect(fetch).toHaveBeenLastCalledWith("/api/files?library=2&prefix=", expect.anything());
  });

  it("counts a write's schedule on the server's clock, from its Date header", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    answer(200, { deleted: 1, scan: SCHEDULED }, { Date: "Fri, 02 Oct 2026 12:00:00 GMT" });

    expect(await deleteFiles(1, ["a"])).toEqual({
      deleted: 1,
      scan: SCHEDULED,
      clock: { serverTime: "2026-10-02T12:00:00.000Z", receivedAt: 5_000 },
    });

    answer(200, { deleted: 0, done: true });
    expect(await deleteFolderRound(1, "A/")).toEqual({
      deleted: 0,
      done: true,
      // No Date header: this browser's clock stands in for the server's.
      clock: { serverTime: new Date(5_000).toISOString(), receivedAt: 5_000 },
    });
    vi.restoreAllMocks();
  });

  it("posts the library, the keys and the prefix as JSON", async () => {
    const fetch = answer(200, { deleted: 2, scan: null });
    await deleteFiles(2, ["a", "b"]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/files/delete",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ library: 2, keys: ["a", "b"] }),
      }),
    );
    await deleteFolderRound(1, "A/");
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/files/delete-folder",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ library: 1, prefix: "A/" }),
      }),
    );
  });
});

function page(name: string, cursor: string | null): FolderListing {
  return {
    prefix: "",
    folders: [],
    files: [{ name, key: name, size: 1, uploadedAt: "", kind: "audio" }],
    cursor,
  };
}

describe("the Files queries", () => {
  it("reads the configuration once a session", () => {
    expect(filesConfigQuery.staleTime).toBe(Number.POSITIVE_INFINITY);
  });

  it("reads one folder a page at a time, and never on a return to the tab", () => {
    const query = folderQuery(1, "A/");
    expect(query.queryKey).toEqual(["files", "folder", 1, "A/"]);
    expect(query.staleTime).toBe(30_000);
    expect(query.refetchOnWindowFocus).toBe(false);
    expect(query.getNextPageParam(page("a", "next"), [], null, [])).toBe("next");
    expect(query.getNextPageParam(page("a", null), [], null, [])).toBeNull();
    // Each library's folders are their own entries.
    expect(folderQuery(2, "A/").queryKey).toEqual(["files", "folder", 2, "A/"]);
  });

  /**
   * A folder on screen with two pages loaded, as the page's observer holds
   * it, and an inactive one with two pages, a folder opened before.
   */
  async function twoPagesOnScreen() {
    const queryClient = new QueryClient();
    const fetch = vi.fn(async (url: string) => {
      const cursor = new URL(url, "http://console").searchParams.get("cursor");
      const body = cursor === null ? page("first", "c1") : page("second", null);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const observer = new InfiniteQueryObserver(queryClient, folderQuery(1, "A/"));
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().data?.pages).toHaveLength(2);
    queryClient.setQueryData<InfiniteData<FolderListing, string | null>>(
      folderQuery(1, "B/").queryKey,
      { pages: [page("b1", "c1"), page("b2", null)], pageParams: [null, "c1"] },
    );
    fetch.mockClear();
    return { queryClient, fetch, observer, unsubscribe };
  }

  it("leaves another library's folders alone after a change", async () => {
    const { queryClient, fetch, unsubscribe } = await twoPagesOnScreen();

    await afterFilesChange(queryClient, 2);

    expect(fetch).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(folderQuery(1, "B/").queryKey)?.isInvalidated).toBe(false);
    unsubscribe();
  });

  it("reads only the first page of the folder on screen after a change", async () => {
    const { queryClient, fetch, observer, unsubscribe } = await twoPagesOnScreen();

    await afterFilesChange(queryClient, 1);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/files?library=1&prefix=A%2F", expect.anything());
    expect(observer.getCurrentResult().data?.pages).toHaveLength(1);
    // The folder not on screen is cut back too, and read again when it opens.
    const other = queryClient.getQueryState(folderQuery(1, "B/").queryKey);
    expect(other?.isInvalidated).toBe(true);
    expect(
      queryClient.getQueryData<InfiniteData<FolderListing, string | null>>(
        folderQuery(1, "B/").queryKey,
      )?.pages,
    ).toHaveLength(1);
    unsubscribe();
  });

  it("after uploads, reads again only the folders the landed keys change", async () => {
    const { queryClient, fetch, observer, unsubscribe } = await twoPagesOnScreen();
    queryClient.setQueryData<InfiniteData<FolderListing, string | null>>(
      folderQuery(1, "").queryKey,
      {
        pages: [
          {
            prefix: "",
            folders: [
              { name: "A", prefix: "A/" },
              { name: "B", prefix: "B/" },
            ],
            files: [],
            cursor: null,
          },
        ],
        pageParams: [null],
      },
    );
    const pagesOf = (prefix: string) =>
      queryClient.getQueryData<InfiniteData<FolderListing, string | null>>(
        folderQuery(1, prefix).queryKey,
      )?.pages.length;

    // A key of another library changes none of library 1's folders.
    await afterUploadsLanded(queryClient, [{ library: 2, key: "B/01.flac" }]);
    expect(queryClient.getQueryState(folderQuery(1, "B/").queryKey)?.isInvalidated).toBe(false);

    // Into B/, which the root lists already: only B/ changes.
    await afterUploadsLanded(queryClient, [{ library: 1, key: "B/01.flac" }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(observer.getCurrentResult().data?.pages).toHaveLength(2);
    expect(pagesOf("B/")).toBe(1);
    expect(queryClient.getQueryState(folderQuery(1, "B/").queryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(folderQuery(1, "").queryKey)?.isInvalidated).toBe(false);

    // A new folder at the root changes the root only.
    await afterUploadsLanded(queryClient, [{ library: 1, key: "New/01.flac" }]);
    expect(fetch).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(folderQuery(1, "").queryKey)?.isInvalidated).toBe(true);
    expect(observer.getCurrentResult().data?.pages).toHaveLength(2);

    // Into a new subfolder of A/, the folder on screen: read again, from its
    // first page, since its listing gains the folder.
    await afterUploadsLanded(queryClient, [{ library: 1, key: "A/Sub/02.flac" }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/files?library=1&prefix=A%2F", expect.anything());
    expect(observer.getCurrentResult().data?.pages).toHaveLength(1);
    unsubscribe();
  });

  it("cuts a folder it leaves back to its first page, so a stale return reads one", async () => {
    const { queryClient, fetch, unsubscribe } = await twoPagesOnScreen();
    unsubscribe();

    leaveFolder(queryClient, 1, "A/");
    await queryClient.invalidateQueries({ queryKey: folderQuery(1, "A/").queryKey });
    const back = new InfiniteQueryObserver(queryClient, folderQuery(1, "A/"));
    const again = back.subscribe(() => {});
    await vi.waitFor(() => expect(back.getCurrentResult().isFetching).toBe(false));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(back.getCurrentResult().data?.pages).toHaveLength(1);
    again();
  });

  it("opens a folder again from its first page after a refused cursor", async () => {
    const { queryClient, fetch, observer, unsubscribe } = await twoPagesOnScreen();

    await reopenFolder(queryClient, 1, "A/");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/files?library=1&prefix=A%2F", expect.anything());
    expect(observer.getCurrentResult().data?.pages.map((p) => p.files[0]?.name)).toEqual(["first"]);
    unsubscribe();
  });
});
