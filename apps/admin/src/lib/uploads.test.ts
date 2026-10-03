import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  type CompleteUploadsResult,
  type FilesConfig,
  type FolderEntry,
  type PresignedUpload,
  type ScanSchedule,
  type SignedResult,
  type SignUploadsResult,
  type UploadToSign,
} from "@/lib/api";
import { describeError } from "@/lib/errors";
import {
  CHECK_BATCH,
  CHECK_ROUNDS,
  COMPLETE_QUIET_MS,
  checkBatches,
  checkUpload,
  decideConflicts,
  describeConflicts,
  describeFailure,
  describeHidden,
  describeQueue,
  describeUnchecked,
  describeUploadsStatus,
  EXPIRY_MARGIN_MS,
  findConflicts,
  NOTIFY_EVERY_MS,
  notUploadedToast,
  type PickedFile,
  PLAN_SLICE,
  type PlannedUpload,
  percentOf,
  planUploads,
  planUploadsInSlices,
  REFRESH_EVERY_MS,
  type RunSummary,
  shownRows,
  splitKey,
  UploadQueue,
  type UploadView,
  uploadedToast,
  uploadsStatus,
  uploadsStatusSuffix,
  uploadTarget,
  watchPage,
  xhrPut,
} from "@/lib/uploads";

/**
 * `GET /api/files/config` as the server answers it with uploads configured
 * (apps/server test/files-api.test.ts records the same allow-list and limits).
 */
const CONFIG: FilesConfig = {
  bucket: "navidrome",
  uploads: { configured: true },
  allowed: {
    audio: { suffixes: ["mp3", "m4a", "flac"], maxBytes: 5_363_466_240 },
    lyrics: { suffixes: ["lrc", "txt"], maxBytes: 1_048_576 },
    playlist: { suffixes: ["m3u", "m3u8"], maxBytes: 4_194_304 },
    image: { suffixes: ["jpg", "png", "gif", "webp", "jpeg"], maxBytes: 20_971_520 },
  },
  limits: { maxKeyBytes: 1024, maxSegmentBytes: 255, signBatch: 10, deleteBatch: 250 },
  rescanQuietSeconds: 120,
  writes: { enabled: true },
};

const NOW = Date.parse("2026-10-02T12:00:00Z");

/** A picked file of `size` bytes; the queue never reads its bytes. */
function picked(name: string, size = 1000, webkitRelativePath = ""): PickedFile {
  return { name, size, webkitRelativePath } as unknown as PickedFile;
}

const noFolders = () => undefined;

/** Planned uploads into `prefix`, by file name. */
function plan(prefix: string, ...names: string[]): PlannedUpload[] {
  return planUploads(
    names.map((name) => picked(name)),
    prefix,
    CONFIG,
    noFolders,
  );
}

/** Lets every settled promise run its callbacks. */
async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

interface SignCall {
  prefix: string;
  files: UploadToSign[];
  resolve: (result: SignUploadsResult) => void;
  reject: (error: unknown) => void;
}

interface PutCall {
  upload: PresignedUpload;
  body: Blob;
  onProgress: (loaded: number) => void;
  signal: AbortSignal;
  resolve: (status: number) => void;
}

interface CompleteCall {
  keys: string[];
  resolve: (result: CompleteUploadsResult) => void;
  reject: (error: unknown) => void;
}

const SCHEDULED: ScanSchedule = {
  scheduledAt: "2026-10-02T12:02:00.000Z",
  afterCurrentPass: false,
};

/** The server's clock as an answer carries it: in step with the test's. */
function clock(at = NOW) {
  return { serverTime: new Date(at).toISOString(), receivedAt: at };
}

/** A URL signed for `key`, expiring `ttlMs` after `NOW`. */
function url(key: string, ttlMs = 300_000): SignedResult {
  return {
    key,
    url: `https://account.r2.cloudflarestorage.com/navidrome/${encodeURIComponent(key)}?X-Amz-Expires=300`,
    method: "PUT",
    headers: { "Content-Type": "audio/flac", "If-None-Match": "*" },
    expiresAt: new Date(NOW + ttlMs).toISOString(),
  };
}

/**
 * A queue whose every call waits for the test to answer it, on fake timers
 * (`quiet` lets the hold of landed keys run out).
 */
function harness(now: () => number = () => NOW) {
  if (!vi.isFakeTimers()) {
    vi.useFakeTimers({ now: NOW });
  }
  const signs: SignCall[] = [];
  const puts: PutCall[] = [];
  const completes: CompleteCall[] = [];
  const drained: RunSummary[] = [];
  const errors: unknown[] = [];
  const refresh = vi.fn();
  const queue = new UploadQueue(
    {
      sign: (prefix, files) =>
        new Promise((resolve, reject) =>
          signs.push({ prefix, files: [...files], resolve, reject }),
        ),
      put: (upload, body, onProgress, signal) =>
        new Promise((resolve) => puts.push({ upload, body, onProgress, signal, resolve })),
      complete: (keys) =>
        new Promise((resolve, reject) => completes.push({ keys: [...keys], resolve, reject })),
    },
    {
      now,
      onRefresh: refresh,
      onDrained: (summary) => drained.push(summary),
      onError: (error) => errors.push(error),
    },
  );
  const states = () => queue.getSnapshot().items.map((item) => item.state);
  const item = (key: string): UploadView => {
    const found = queue.getSnapshot().items.find((view) => view.key === key);
    if (!found) {
      throw new Error(`no row for ${key}`);
    }
    return found;
  };
  /** Answers sign call `index` with a URL for each file. */
  const signAll = async (index: number, ttlMs?: number) => {
    const call = signs[index];
    if (!call) {
      throw new Error(`no sign call ${index}`);
    }
    call.resolve({ uploads: call.files.map((file) => url(file.key, ttlMs)), clock: clock() });
    await tick();
  };
  const putDone = async (index: number, status = 200) => {
    const call = puts[index];
    if (!call) {
      throw new Error(`no put ${index}`);
    }
    call.resolve(status);
    await tick();
  };
  const completeDone = async (index: number, scan: ScanSchedule | null = SCHEDULED) => {
    const call = completes[index];
    if (!call) {
      throw new Error(`no complete ${index}`);
    }
    call.resolve({ scan, clock: clock() });
    await tick();
  };
  /** Lets `COMPLETE_QUIET_MS` pass with nothing new landing. */
  const quiet = async () => {
    vi.advanceTimersByTime(COMPLETE_QUIET_MS);
    await tick();
  };
  return {
    queue,
    quiet,
    signs,
    puts,
    completes,
    drained,
    errors,
    refresh,
    states,
    item,
    signAll,
    putDone,
    completeDone,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

/* ---------------------------------------------------------------- keys -- */

describe("the key a picked file takes", () => {
  it("is the current folder and the file's name, or its path from a folder pick", () => {
    expect(uploadTarget("Artist/", "01 Song.flac", noFolders)).toEqual({
      prefix: "Artist/",
      key: "Artist/01 Song.flac",
    });
    expect(uploadTarget("", "Album/CD1/01 Song.flac", noFolders)).toEqual({
      prefix: "",
      key: "Album/CD1/01 Song.flac",
    });
    const [fromFolder] = planUploads(
      [picked("01.flac", 10, "Album/CD1/01.flac")],
      "Artist/",
      CONFIG,
      noFolders,
    );
    expect(fromFolder).toMatchObject({ prefix: "Artist/", key: "Artist/Album/CD1/01.flac" });
  });

  it("writes the new part in NFC, and keeps the listed folder exactly as listed", () => {
    const nfd = "Björk/";
    const target = uploadTarget(nfd, "Jóga.flac", noFolders);
    expect(target.prefix).toBe(nfd);
    expect(target.key).toBe(`${nfd}Jóga.flac`);
  });

  it("goes as deep as the loaded listings show, taking each folder's stored spelling", () => {
    const listings: Record<string, FolderEntry[]> = {
      "": [{ name: "Björk", prefix: "Björk/" }],
      "Björk/": [{ name: "Homogenic", prefix: "Björk/Homogenic/" }],
    };
    const lookup = (prefix: string) => listings[prefix];
    // Picked on Linux, in NFC: the NFD folder the bucket holds is the one.
    expect(uploadTarget("", "Björk/Homogenic/CD1/01.flac", lookup)).toEqual({
      prefix: "Björk/Homogenic/",
      key: "Björk/Homogenic/CD1/01.flac",
    });
    // A folder no listing shows ends the walk.
    expect(uploadTarget("", "Other/01.flac", lookup).prefix).toBe("");
  });

  it("does not guess between two listed spellings of one name", () => {
    // "Å" three ways: ANGSTROM SIGN, A + COMBINING RING, and the composed
    // letter, which is what NFC makes of both.
    const listings: Record<string, FolderEntry[]> = {
      "": [
        { name: "Å", prefix: "Å/" },
        { name: "Å", prefix: "Å/" },
      ],
    };
    const lookup = (prefix: string) => listings[prefix];
    // The exact spelling is still found.
    expect(uploadTarget("", "Å/01.flac", lookup).prefix).toBe("Å/");
    // The composed one matches both, so the walk stops at the folder on
    // screen and the server writes a new NFC key.
    expect(uploadTarget("", "Å/01.flac", lookup)).toEqual({ prefix: "", key: "Å/01.flac" });
  });

  it("goes by path, numbers by their value, whatever order the browser gave", () => {
    const planned = planUploads(
      [
        picked("10 Ten.flac", 10, "Album/CD2/10 Ten.flac"),
        picked("2 Two.flac", 10, "Album/CD1/2 Two.flac"),
        picked("10 Ten.flac", 10, "Album/CD1/10 Ten.flac"),
        picked("cover.jpg", 10, "Album/cover.jpg"),
      ],
      "",
      CONFIG,
      noFolders,
    );
    expect(planned.map(({ key }) => key)).toEqual([
      "Album/CD1/2 Two.flac",
      "Album/CD1/10 Ten.flac",
      "Album/CD2/10 Ten.flac",
      "Album/cover.jpg",
    ]);
  });

  it("refuses the second file of a pick that maps to a key already planned", () => {
    // A disk that keeps both Unicode spellings: both map to one NFC key.
    const planned = planUploads(
      [
        picked("Café.flac".normalize("NFD"), 10, "Album/Café.flac".normalize("NFD")),
        picked("Café.flac".normalize("NFC"), 10, "Album/Café.flac".normalize("NFC")),
        picked("02.flac", 10, "Album/02.flac"),
      ],
      "",
      CONFIG,
      noFolders,
    );
    expect(planned.map(({ refusal }) => refusal).sort()).toEqual([null, null, "same_name"]);
    const refused = planned.find((upload) => upload.refusal === "same_name");
    expect(refused?.key).toBe("Album/Café.flac".normalize("NFC"));
    expect(describeFailure({ code: "same_name" }, refused?.key ?? "", CONFIG)).toBe(
      "another file in this pick has the same name",
    );
  });

  it("refuses a same-name twin in a large pick planned in slices too", async () => {
    const files = [
      ...Array.from({ length: PLAN_SLICE + 1 }, (_, i) => picked(`${i}.flac`, 10, `A/${i}.flac`)),
      picked("0.flac", 10, "A/0.flac"),
    ];
    const planned = await planUploadsInSlices(files, "", CONFIG, noFolders, async () => {});
    expect(planned.filter(({ refusal }) => refusal === "same_name")).toHaveLength(1);
  });

  it("leaves a folder pick's hidden files out, and refuses one picked by name", () => {
    const planned = planUploads(
      [
        picked(".DS_Store", 6148, "Album/.DS_Store"),
        picked("._01.flac", 4096, "Album/._01.flac"),
        picked("01.flac", 10, "Album/01.flac"),
        picked(".hidden.flac", 10),
      ],
      "",
      CONFIG,
      noFolders,
    );
    expect(planned.map(({ key, refusal }) => [key, refusal])).toEqual([
      [".hidden.flac", "invalid_path"],
      ["Album/01.flac", null],
    ]);
  });
});

describe("the client's mirror of the allow-list", () => {
  it("takes every suffix the server allows, in any case, within its kind's size", () => {
    for (const key of [
      "a.mp3",
      "a.M4A",
      "a.FLAC",
      "a.lrc",
      "a.txt",
      "a.m3u",
      "a.m3u8",
      "a.JPEG",
      "a.webp",
    ]) {
      expect(checkUpload(`Artist/${key}`, 1000, CONFIG)).toBeNull();
    }
    expect(checkUpload("a.flac", 5_363_466_240, CONFIG)).toBeNull();
  });

  it("refuses what the server would, in the server's order", () => {
    expect(checkUpload("Album/booklet.pdf", 1000, CONFIG)).toBe("type_not_allowed");
    expect(checkUpload("Album/noext", 1000, CONFIG)).toBe("type_not_allowed");
    expect(checkUpload("a.flac", 0, CONFIG)).toBe("empty_file");
    expect(checkUpload("a.flac", 5_363_466_241, CONFIG)).toBe("too_large");
    expect(checkUpload("a.lrc", 1_048_577, CONFIG)).toBe("too_large");
    expect(checkUpload("a.jpg", 20_971_521, CONFIG)).toBe("too_large");
    expect(checkUpload("_covers/a.jpg", 10, CONFIG)).toBe("reserved_path");
    expect(checkUpload(".hidden/a.flac", 10, CONFIG)).toBe("invalid_path");
    expect(checkUpload("a//b.flac", 10, CONFIG)).toBe("invalid_path");
    expect(checkUpload("a\\b.flac", 10, CONFIG)).toBe("invalid_path");
    expect(checkUpload("a\u0001.flac", 10, CONFIG)).toBe("invalid_path");
    expect(checkUpload("a\ud800.flac", 10, CONFIG)).toBe("invalid_path");
    // 400 three-byte characters are 1,200 bytes of UTF-8, though each
    // folder's 80 are only 240.
    const wide = Array.from({ length: 5 }, () => "一".repeat(80)).join("/");
    expect(checkUpload(`${wide}.flac`, 10, CONFIG)).toBe("path_too_long");
    expect(checkUpload(`${"a".repeat(251)}.flac`, 10, CONFIG)).toBe("path_too_long");
    expect(checkUpload(`${"a".repeat(250)}.flac`, 10, CONFIG)).toBeNull();
    // A refused type wins over a refused size, as on the server.
    expect(checkUpload("a.pdf", 0, CONFIG)).toBe("type_not_allowed");
  });

  it("refuses a .pdf before any request is made", async () => {
    const h = harness();
    h.queue.add(plan("Album/", "booklet.pdf"), CONFIG.limits.signBatch);
    await tick();
    expect(h.signs).toHaveLength(0);
    expect(h.puts).toHaveLength(0);
    expect(h.item("Album/booklet.pdf")).toMatchObject({
      state: "failed",
      failure: { code: "type_not_allowed" },
    });
    expect(h.drained).toEqual([{ uploaded: 0, notUploaded: 1, scanUnknown: false }]);
  });
});

/* --------------------------------------------------------------- queue -- */

describe("the upload queue", () => {
  it("signs just in time, at most 3 at once, in one request per free place's batch", async () => {
    const h = harness();
    h.queue.add(plan("A/", "1.flac", "2.flac", "3.flac", "4.flac", "5.flac"), 10);
    expect(h.signs).toHaveLength(1);
    expect(h.signs[0]).toMatchObject({ prefix: "A/" });
    expect(h.signs[0]?.files).toEqual([
      { key: "A/1.flac", size: 1000, overwrite: false },
      { key: "A/2.flac", size: 1000, overwrite: false },
      { key: "A/3.flac", size: 1000, overwrite: false },
    ]);
    expect(h.states()).toEqual(["signing", "signing", "signing", "waiting", "waiting"]);

    await h.signAll(0);
    expect(h.puts).toHaveLength(3);
    expect(h.states()).toEqual(["uploading", "uploading", "uploading", "waiting", "waiting"]);
    // Nothing more is signed while every place is taken.
    expect(h.signs).toHaveLength(1);

    await h.putDone(0);
    expect(h.signs).toHaveLength(2);
    expect(h.signs[1]?.files.map((file) => file.key)).toEqual(["A/4.flac"]);
    expect(h.states()).toEqual(["uploaded", "uploading", "uploading", "signing", "waiting"]);
  });

  it("never signs more than limits.signBatch at once", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac", "2.flac", "3.flac"), 1);
    expect(h.signs.map((call) => call.files.length)).toEqual([1, 1, 1]);
  });

  it("sends exactly the signed headers to the signed URL, with the file as the body", async () => {
    const h = harness();
    const [planned] = plan("", "1.flac");
    if (!planned) {
      throw new Error("nothing planned");
    }
    h.queue.add([planned], 10);
    await h.signAll(0);
    expect(h.puts[0]?.upload).toEqual(url("1.flac"));
    expect(h.puts[0]?.body).toBe(planned.file);
  });

  it("reports progress in whole percent", async () => {
    const h = harness();
    h.queue.add(planUploads([picked("1.flac", 400)], "", CONFIG, noFolders), 10);
    await h.signAll(0);
    const before = h.queue.getSnapshot();
    h.puts[0]?.onProgress(1);
    // Under one percent: no new snapshot.
    expect(h.queue.getSnapshot()).toBe(before);
    h.puts[0]?.onProgress(148);
    expect(percentOf(h.item("1.flac"))).toBe(37);
  });

  it("holds landed keys, and reports them together once 2 s pass with nothing new", async () => {
    const h = harness();
    h.queue.add(plan("A/", "1.flac", "2.flac", "3.flac"), 10);
    await h.signAll(0);
    await h.putDone(0);
    await h.putDone(1, 500);
    vi.advanceTimersByTime(COMPLETE_QUIET_MS - 1);
    await h.putDone(2);
    // 3.flac landed inside the window, which starts again.
    vi.advanceTimersByTime(COMPLETE_QUIET_MS - 1);
    await tick();
    expect(h.completes).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await tick();
    expect(h.completes.map((call) => call.keys)).toEqual([["A/1.flac", "A/3.flac"]]);
    // The queue's run lasts until the report is answered.
    expect(h.drained).toEqual([]);
    await h.completeDone(0);
    expect(h.queue.getSnapshot().schedule?.scan).toEqual(SCHEDULED);
    expect(h.drained).toEqual([{ uploaded: 2, notUploaded: 1, scanUnknown: false }]);
  });

  it("reports at once when limits.signBatch keys wait, whatever the sign requests", async () => {
    const h = harness();
    const names = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, "0")}.flac`);
    h.queue.add(plan("", ...names), 10);
    let signed = 0;
    for (let done = 0; done < 12; done++) {
      while (signed < h.signs.length) {
        await h.signAll(signed++);
      }
      await h.putDone(done);
    }
    // Ten landed: reported then, without waiting; the last two after the window.
    expect(h.completes.map((call) => call.keys.length)).toEqual([10]);
    await h.quiet();
    expect(h.completes.map((call) => call.keys)).toEqual([names.slice(0, 10), names.slice(10)]);
  });

  it("completes with the key the server signed, not the one asked for", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac"), 10);
    h.signs[0]?.resolve({ uploads: [url("Stored/1.flac")], clock: clock() });
    await tick();
    await h.putDone(0);
    await h.quiet();
    expect(h.completes[0]?.keys).toEqual(["Stored/1.flac"]);
  });

  it("sends an NFD listed prefix verbatim, and keeps it in every key", async () => {
    const h = harness();
    const nfd = "Björk/Homogénic/";
    h.queue.add(plan(nfd, "Jóga.flac"), 10);
    expect(h.signs[0]?.prefix).toBe(nfd);
    expect(h.signs[0]?.files[0]?.key).toBe(`${nfd}Jóga.flac`);
  });

  it("signs files of different folders in different requests", async () => {
    const h = harness();
    const planned = planUploads(
      [
        picked("1.flac", 10, "X/1.flac"),
        picked("2.flac", 10, "Y/2.flac"),
        picked("3.flac", 10, "X/3.flac"),
      ],
      "",
      CONFIG,
      (prefix) =>
        prefix === ""
          ? [
              { name: "X", prefix: "X/" },
              { name: "Y", prefix: "Y/" },
            ]
          : undefined,
    );
    h.queue.add(planned, 10);
    expect(h.signs.map((call) => [call.prefix, call.files.map((file) => file.key)])).toEqual([
      ["X/", ["X/1.flac", "X/3.flac"]],
      ["Y/", ["Y/2.flac"]],
    ]);
  });

  it("never uploads two files to one key at once", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac"), 10);
    h.queue.add(plan("", "1.flac", "2.flac"), 10);
    expect(h.signs.map((call) => call.files.map((file) => file.key))).toEqual([
      ["1.flac"],
      ["2.flac"],
    ]);
    await h.signAll(0);
    await h.putDone(0);
    // The second 1.flac starts once the first is done (and finds it there).
    expect(h.signs[2]?.files).toEqual([{ key: "1.flac", size: 1000, overwrite: false }]);
  });

  describe("a key that exists by the time it is signed or sent", () => {
    it("is Failed as uploaded elsewhere just now, with no prompt, when the server says exists", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac", "2.flac"), 10);
      h.signs[0]?.resolve({
        uploads: [
          {
            key: "1.flac",
            error: "exists",
            existing: { size: 5, uploadedAt: "2026-01-01T00:00:00Z" },
          },
          url("2.flac"),
        ],
        clock: clock(),
      });
      await tick();
      const row = h.item("1.flac");
      expect(row).toMatchObject({ state: "failed", failure: { code: "exists_now" } });
      expect(describeFailure(row.failure ?? { code: "invalid_path" }, row.key, CONFIG)).toBe(
        "uploaded elsewhere just now. Upload it again to replace it.",
      );
      await h.putDone(0);
      await h.quiet();
      await h.completeDone(0);
      expect(h.drained).toEqual([{ uploaded: 1, notUploaded: 1, scanUnknown: false }]);
      // Nothing signs it again by itself.
      expect(h.signs).toHaveLength(1);
    });

    it("is Failed the same way on R2's 412, and not reported", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac"), 10);
      await h.signAll(0);
      await h.putDone(0, 412);
      expect(h.item("1.flac")).toMatchObject({ state: "failed", failure: { code: "exists_now" } });
      expect(h.signs).toHaveLength(1);
      await h.quiet();
      expect(h.completes).toHaveLength(0);
    });

    it("a Replace the server cannot spell is Failed, with rclone named", async () => {
      const h = harness();
      h.queue.add(
        plan("", "1.flac").map((upload) => ({ ...upload, overwrite: true })),
        10,
      );
      expect(h.signs[0]?.files).toEqual([{ key: "1.flac", size: 1000, overwrite: true }]);
      h.signs[0]?.resolve({
        uploads: [{ key: "1.flac", error: "replace_unavailable" }],
        clock: clock(),
      });
      await tick();
      const row = h.item("1.flac");
      expect(row).toMatchObject({ state: "failed", failure: { code: "replace_unavailable" } });
      expect(describeFailure(row.failure ?? { code: "invalid_path" }, row.key, CONFIG)).toMatch(
        /rclone/,
      );
    });
  });

  it("answers each server refusal per file, and signs the rest", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac", "2.flac"), 10);
    h.signs[0]?.resolve({
      uploads: [{ key: "1.flac", error: "path_too_long" }, url("2.flac")],
      clock: clock(),
    });
    await tick();
    expect(h.states()).toEqual(["failed", "uploading"]);
  });

  describe("signing again", () => {
    it("signs again, once, a URL within 30 s of its expiry, on the server's clock", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac"), 10);
      await h.signAll(0, EXPIRY_MARGIN_MS - 1000);
      expect(h.puts).toHaveLength(0);
      expect(h.signs).toHaveLength(2);
      expect(h.signs[1]?.files).toEqual([{ key: "1.flac", size: 1000, overwrite: false }]);
      // The second URL is as short; it is used rather than signed forever.
      await h.signAll(1, EXPIRY_MARGIN_MS - 1000);
      expect(h.puts).toHaveLength(1);
    });

    it("counts the expiry on the server's clock, not the browser's", async () => {
      // The browser's clock is ten minutes ahead of the server's: by it,
      // the URL has expired, but the server's gives it five minutes.
      const browser = NOW + 600_000;
      const h = harness(() => browser);
      h.queue.add(plan("", "1.flac"), 10);
      h.signs[0]?.resolve({
        uploads: [url("1.flac")],
        clock: { serverTime: new Date(NOW).toISOString(), receivedAt: browser },
      });
      await tick();
      expect(h.puts).toHaveLength(1);
      expect(h.signs).toHaveLength(1);
    });

    it("signs again and retries once after a network error, then fails", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac"), 10);
      await h.signAll(0);
      await h.putDone(0, 0);
      expect(h.item("1.flac").state).toBe("signing");
      expect(h.signs).toHaveLength(2);
      await h.signAll(1);
      await h.putDone(1, 0);
      expect(h.item("1.flac")).toMatchObject({
        state: "failed",
        failure: { code: "put_failed", status: 0 },
      });
      expect(h.signs).toHaveLength(2);
    });

    it("retries once after a 403 (an expired or refused URL), and succeeds", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac"), 10);
      await h.signAll(0);
      await h.putDone(0, 403);
      await h.signAll(1);
      await h.putDone(1, 200);
      expect(h.item("1.flac").state).toBe("uploaded");
      await h.quiet();
      expect(h.completes.map((call) => call.keys)).toEqual([["1.flac"]]);
    });

    it("does not retry any other failed status", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac"), 10);
      await h.signAll(0);
      await h.putDone(0, 400);
      expect(h.item("1.flac")).toMatchObject({ failure: { code: "put_failed", status: 400 } });
      expect(h.signs).toHaveLength(1);
    });
  });

  describe("a sign request that fails", () => {
    it("fails its files, and goes on with the next", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac", "2.flac", "3.flac", "4.flac"), 10);
      h.signs[0]?.reject(new ApiError(0, "network", ""));
      await tick();
      expect(h.states()).toEqual(["failed", "failed", "failed", "signing"]);
      expect(h.errors).toHaveLength(1);
    });

    it("fails every waiting file when the refusal would meet them all", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac", "2.flac", "3.flac", "4.flac"), 10);
      h.signs[0]?.reject(new ApiError(401, "unauthenticated", ""));
      await tick();
      expect(h.states()).toEqual(["failed", "failed", "failed", "failed"]);
      expect(h.signs).toHaveLength(1);
      expect(h.drained).toEqual([{ uploaded: 0, notUploaded: 4, scanUnknown: false }]);
    });
  });

  describe("cancel", () => {
    it("aborts a running upload, and starts the next", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac", "2.flac", "3.flac", "4.flac"), 10);
      await h.signAll(0);
      h.queue.cancel(h.item("1.flac").id);
      expect(h.puts[0]?.signal.aborted).toBe(true);
      expect(h.item("1.flac").state).toBe("canceled");
      expect(h.signs[1]?.files.map((file) => file.key)).toEqual(["4.flac"]);
      // The aborted PUT answers 0; it is not retried.
      await h.putDone(0, 0);
      expect(h.item("1.flac").state).toBe("canceled");
      expect(h.signs).toHaveLength(2);
    });

    it("drops a file being signed, and reports the rest", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac", "2.flac"), 10);
      h.queue.cancel(h.item("1.flac").id);
      await h.signAll(0);
      expect(h.puts.map((call) => call.upload)).toEqual([url("2.flac")]);
      await h.putDone(0);
      await h.quiet();
      expect(h.completes.map((call) => call.keys)).toEqual([["2.flac"]]);
    });

    it("cancels everything at once, and a canceled file is in no summary", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac", "2.flac", "3.flac", "4.flac"), 10);
      await h.signAll(0);
      h.queue.cancelAll();
      expect(h.states()).toEqual(["canceled", "canceled", "canceled", "canceled"]);
      expect(h.queue.getSnapshot().busy).toBe(false);
      expect(h.drained).toEqual([]);
    });
  });

  it("is busy while a file waits or is sent, which beforeunload warns about", async () => {
    const h = harness();
    const target = new EventTarget();
    const stop = watchPage(h.queue, target as unknown as Window);
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(unload()).toBe(false);
    h.queue.add(plan("", "1.flac"), 10);
    expect(unload()).toBe(true);
    await h.signAll(0);
    expect(unload()).toBe(true);
    await h.putDone(0);
    expect(unload()).toBe(false);
    stop();
  });

  it("reports the landed keys it holds at pagehide", async () => {
    const h = harness();
    const target = new EventTarget();
    const stop = watchPage(h.queue, target as unknown as Window);
    h.queue.add(plan("", "1.flac", "2.flac"), 10);
    await h.signAll(0);
    await h.putDone(0);
    expect(h.completes).toHaveLength(0);
    target.dispatchEvent(new Event("pagehide"));
    expect(h.completes.map((call) => call.keys)).toEqual([["1.flac"]]);
    // The rest of the request is reported on its own once done.
    await h.putDone(1);
    await h.quiet();
    expect(h.completes.map((call) => call.keys)).toEqual([["1.flac"], ["2.flac"]]);
    stop();
  });

  it("says when the scan is unknown: a null schedule, or a failed report", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac"), 10);
    await h.signAll(0);
    await h.putDone(0);
    await h.quiet();
    await h.completeDone(0, null);
    expect(h.drained.at(-1)?.scanUnknown).toBe(true);

    h.queue.add(plan("", "2.flac"), 10);
    await h.signAll(1);
    await h.putDone(1);
    await h.quiet();
    h.completes[1]?.reject(new ApiError(500, "internal", ""));
    await tick();
    expect(h.drained.at(-1)).toEqual({
      uploaded: 1,
      notUploaded: 0,
      scanUnknown: true,
    });
    expect(h.item("2.flac").state).toBe("uploaded");
  });

  it("reads the folder again at most once every 5 s, and once after the last upload", async () => {
    vi.useFakeTimers({ now: NOW });
    const h = harness(() => Date.now());
    h.queue.add(plan("", "1.flac", "2.flac", "3.flac"), 10);
    await h.signAll(0);
    await h.putDone(0);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    await h.putDone(1);
    await h.putDone(2);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(REFRESH_EVERY_MS);
    expect(h.refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(REFRESH_EVERY_MS * 3);
    expect(h.refresh).toHaveBeenCalledTimes(2);
    // Each read names the keys landed since the last, for the folders they change.
    expect(h.refresh.mock.calls).toEqual([[["1.flac"]], [["2.flac", "3.flac"]]]);
  });

  it("clears the finished rows and keeps the rest", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac", "2.flac", "3.flac", "4.flac", "x.pdf"), 10);
    h.signs[0]?.resolve({
      uploads: [
        url("1.flac"),
        {
          key: "2.flac",
          error: "exists",
          existing: { size: 1, uploadedAt: "2026-01-01T00:00:00Z" },
        },
        url("3.flac"),
      ],
      clock: clock(),
    });
    await tick();
    await h.putDone(0);
    h.queue.clearFinished();
    expect(h.queue.getSnapshot().items.map((item) => [item.key, item.state])).toEqual([
      ["3.flac", "uploading"],
      ["4.flac", "signing"],
    ]);
  });
});

/* --------------------------------------------------------------- check -- */

describe("the check before anything is signed", () => {
  const existing = (key: string, size = 31_234_567) => ({
    key,
    storedKey: key,
    size,
    uploadedAt: "2026-09-30T12:00:00.000Z",
  });

  it("batches the files the mirror took by folder prefix, at most 1,000 a request", () => {
    const planned = planUploads(
      [
        ...Array.from({ length: CHECK_BATCH * 2 + 1 }, (_, i) =>
          picked(`${i}.flac`, 10, `X/${i}.flac`),
        ),
        picked("2.flac", 10, "Y/2.flac"),
        picked("notes.pdf", 10, "Y/notes.pdf"),
      ],
      "",
      CONFIG,
      (prefix) =>
        prefix === ""
          ? [
              { name: "X", prefix: "X/" },
              { name: "Y", prefix: "Y/" },
            ]
          : undefined,
    );
    const batches = checkBatches(planned);
    expect(batches.map(({ prefix, keys }) => [prefix, keys.length])).toEqual([
      ["X/", CHECK_BATCH],
      ["X/", CHECK_BATCH],
      ["X/", 1],
      ["Y/", 1],
    ]);
    // The refused .pdf is never asked about.
    expect(batches.flatMap((batch) => batch.keys)).not.toContain("Y/notes.pdf");
  });

  it("finds the conflicts in the order picked", async () => {
    const planned = plan("A/", "1.flac", "2.flac", "3.flac", "x.pdf");
    const check = vi.fn(async () => ({
      existing: [existing("A/3.flac"), existing("A/1.flac")],
      unchecked: [],
    }));

    const { conflicts, unchecked } = await findConflicts(planned, check);

    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("A/", ["A/1.flac", "A/2.flac", "A/3.flac"]);
    expect(conflicts.map(({ upload, existing }) => [upload.key, existing.size])).toEqual([
      ["A/1.flac", 31_234_567],
      ["A/3.flac", 31_234_567],
    ]);
    expect(unchecked).toEqual([]);
  });

  it("asks again for what the server left unchecked, past 40 folders, until all is checked", async () => {
    // 45 album folders of a folder pick, one file each; the server lists 40
    // folders a request, as CHECK_LISTINGS bounds it.
    const planned = planUploads(
      Array.from({ length: 45 }, (_, i) => picked("01.flac", 10, `Pick/CD${i}/01.flac`)),
      "",
      CONFIG,
      noFolders,
    );
    const asked: number[] = [];
    const check = vi.fn(async (_prefix: string, keys: readonly string[]) => {
      asked.push(keys.length);
      return {
        // CD44 exists, in a folder past the first request's budget.
        existing: keys
          .slice(0, 40)
          .filter((key) => key.includes("/CD44/"))
          .map((key) => existing(key)),
        unchecked: keys.slice(40),
      };
    });

    const { conflicts, unchecked } = await findConflicts(planned, check);

    expect(asked).toEqual([45, 5]);
    expect(conflicts.map(({ upload }) => upload.key)).toEqual(["Pick/CD44/01.flac"]);
    expect(unchecked).toEqual([]);
  });

  it("sets aside a folder too large to check, and checks the rest past it", async () => {
    const planned = plan("A/", "1.flac", "2.flac", "3.flac");
    // A/1.flac's folder is too large: whenever asked first, it takes the
    // whole budget, so the server checks nothing else in that request.
    const check = vi.fn(async (_prefix: string, keys: readonly string[]) =>
      keys[0] === "A/1.flac"
        ? { existing: [], unchecked: [...keys] }
        : { existing: keys.includes("A/3.flac") ? [existing("A/3.flac")] : [], unchecked: [] },
    );

    const { conflicts, unchecked } = await findConflicts(planned, check);

    // Every key of A/ is in that same folder here, so all of them stay unchecked.
    expect(conflicts).toEqual([]);
    expect(unchecked.map((upload) => upload.key)).toEqual(["A/1.flac", "A/2.flac", "A/3.flac"]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("checks the other folders of a pick once a too-large one is set aside", async () => {
    const planned = planUploads(
      [picked("1.flac", 10, "Pick/Big/1.flac"), picked("2.flac", 10, "Pick/Small/2.flac")],
      "",
      CONFIG,
      noFolders,
    );
    const check = vi.fn(async (_prefix: string, keys: readonly string[]) =>
      keys[0]?.includes("/Big/")
        ? { existing: [], unchecked: [...keys] }
        : { existing: keys.map((key) => existing(key)), unchecked: [] },
    );

    const { conflicts, unchecked } = await findConflicts(planned, check);

    expect(conflicts.map(({ upload }) => upload.key)).toEqual(["Pick/Small/2.flac"]);
    expect(unchecked.map((upload) => upload.key)).toEqual(["Pick/Big/1.flac"]);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("asks each key once, and ends, when two planned files share a key", async () => {
    // Twins the planner would refuse, here given as they are: their folder
    // takes the whole budget, so nothing is ever checked.
    const [first] = plan("Big/", "Café.flac");
    if (!first) {
      throw new Error("nothing planned");
    }
    const planned = [first, { ...first }];
    const check = vi.fn(async (_prefix: string, keys: readonly string[]) => ({
      existing: [],
      unchecked: [...keys],
    }));

    const { conflicts, unchecked } = await findConflicts(planned, check);

    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith("Big/", ["Big/Café.flac"]);
    expect(conflicts).toEqual([]);
    // Both files of the key may exist, so both are asked about.
    expect(unchecked).toHaveLength(2);
  });

  it(`stops after ${CHECK_ROUNDS} rounds whatever the server answers`, async () => {
    const planned = plan("A/", ...Array.from({ length: 30 }, (_, i) => `${i}.flac`));
    // One key checked a round: progress, but slow.
    const check = vi.fn(async (_prefix: string, keys: readonly string[]) => ({
      existing: [],
      unchecked: keys.slice(1),
    }));

    const { unchecked } = await findConflicts(planned, check);

    expect(check).toHaveBeenCalledTimes(CHECK_ROUNDS);
    expect(unchecked).toHaveLength(30 - CHECK_ROUNDS);
  });

  it("asks nothing for a pick the mirror refused whole", async () => {
    const check = vi.fn();
    expect(await findConflicts(plan("", "a.pdf"), check)).toEqual({ conflicts: [], unchecked: [] });
    expect(check).not.toHaveBeenCalled();
  });

  describe("the owner's one answer", () => {
    const planned = plan("A/", "1.flac", "2.flac", "3.flac", "4.flac");
    // 2.flac exists; 4.flac could not be checked.
    const asked = [planned[1] as PlannedUpload, planned[3] as PlannedUpload];

    it("Replace: every file goes, those asked about with overwrite", () => {
      expect(
        decideConflicts(planned, asked, "replace").map((u) => [u.key, u.overwrite === true]),
      ).toEqual([
        ["A/1.flac", false],
        ["A/2.flac", true],
        ["A/3.flac", false],
        ["A/4.flac", true],
      ]);
    });

    it("Skip: only the rest go", () => {
      expect(decideConflicts(planned, asked, "skip").map((u) => u.key)).toEqual([
        "A/1.flac",
        "A/3.flac",
      ]);
    });

    it("Cancel: nothing goes", () => {
      expect(decideConflicts(planned, asked, "cancel")).toEqual([]);
    });
  });

  it("a Replace is signed with overwrite: true, and nothing else is", async () => {
    const h = harness();
    const planned = plan("A/", "1.flac", "2.flac");
    h.queue.add(decideConflicts(planned, [planned[0] as PlannedUpload], "replace"), 10);
    expect(h.signs[0]?.files).toEqual([
      { key: "A/1.flac", size: 1000, overwrite: true },
      { key: "A/2.flac", size: 1000, overwrite: false },
    ]);
  });

  it("titles the dialog with how many of the pick exist, or could not be checked", () => {
    expect(describeConflicts(3, 0, 25)).toBe("3 of 25 files already exist");
    expect(describeConflicts(1, 2, 25)).toBe("1 of 25 files already exists");
    expect(describeConflicts(1, 0, 1)).toBe("1 of 1 file already exists");
    expect(describeConflicts(1200, 0, 2000)).toBe("1,200 of 2,000 files already exist");
    expect(describeConflicts(0, 2, 25)).toBe("2 of 25 files could not be checked");
    expect(describeUnchecked(2)).toBe("2 files could not be checked, and may already exist.");
  });
});

/* --------------------------------------------------------------- words -- */

describe("the words", () => {
  const view = (state: UploadView["state"]): UploadView => ({
    id: 1,
    key: "a.flac",
    size: 1,
    loaded: 0,
    state,
  });

  it("counts the uploaded of the files meant to go", () => {
    expect(
      describeQueue([view("uploaded"), view("uploading"), view("failed"), view("canceled")]),
    ).toBe("1 of 3 uploaded");
  });

  it("gives the header's trigger its state in words, with no conflict state", () => {
    expect(uploadsStatus([])).toBeNull();
    expect(describeUploadsStatus([])).toBe("");

    // The file the run is on: one past those settled, canceled left out.
    const running = [
      view("uploaded"),
      view("failed"),
      view("uploading"),
      view("signing"),
      view("waiting"),
      view("canceled"),
    ];
    expect(uploadsStatus(running)).toBe("running");
    expect(describeUploadsStatus(running)).toBe("Uploading 3 of 5");
    expect(describeUploadsStatus([view("waiting")])).toBe("Uploading 1 of 1");
    expect(describeUploadsStatus(Array.from({ length: 1_200 }, () => view("waiting")))).toBe(
      "Uploading 1 of 1,200",
    );

    // Failures only, once nothing is left to go.
    const waiting = [view("uploaded"), view("failed"), view("failed"), view("canceled")];
    expect(uploadsStatus(waiting)).toBe("attention");
    expect(describeUploadsStatus(waiting)).toBe("2 need attention");
    expect(describeUploadsStatus([view("uploaded"), view("failed")])).toBe("1 needs attention");

    const done = [view("uploaded"), view("canceled")];
    expect(uploadsStatus(done)).toBe("done");
    expect(describeUploadsStatus(done)).toBe("Uploads done");
  });

  it("splits a row's key into the file's name and its folder", () => {
    expect(splitKey("Aurora Lane/Glass City (2023)/CD1/01 Opening.flac")).toEqual({
      name: "01 Opening.flac",
      folder: "Aurora Lane/Glass City (2023)/CD1",
    });
    expect(splitKey("cover.jpg")).toEqual({ name: "cover.jpg", folder: "" });
  });

  it("says why a file failed", () => {
    expect(describeFailure({ code: "type_not_allowed" }, "a.pdf", CONFIG)).toBe(
      "not a type the server reads",
    );
    expect(describeFailure({ code: "too_large" }, "a.lrc", CONFIG)).toBe(
      "over 1.05 MB, the most for its type (use rclone for larger files)",
    );
    expect(describeFailure({ code: "put_failed", status: 0 }, "a.flac", CONFIG)).toBe(
      "the upload did not reach the bucket",
    );
    expect(describeFailure({ code: "exists_now" }, "a.flac", CONFIG)).toBe(
      "uploaded elsewhere just now. Upload it again to replace it.",
    );
    expect(
      describeFailure(
        { code: "sign_failed", error: new ApiError(0, "network", "") },
        "a.flac",
        CONFIG,
      ),
    ).toBe("the server could not be reached");
  });

  it("toasts what a run did", () => {
    const summary = { uploaded: 12, notUploaded: 2, scanUnknown: false };
    expect(uploadedToast(summary)).toEqual({
      title: "Uploaded 12 files",
      description: "Tracks join the library at the next scan.",
    });
    expect(uploadedToast({ ...summary, uploaded: 1, scanUnknown: true })).toEqual({
      title: "Uploaded 1 file",
      description: "The next scheduled scan will index it.",
    });
    // It names the header's trigger by the words it shows, every failure counted.
    expect(notUploadedToast(summary, 3)).toEqual({
      title: "2 files were not uploaded",
      description: "Open “3 need attention” in the header to see why.",
    });
    expect(notUploadedToast({ ...summary, notUploaded: 1 }, 1)).toEqual({
      title: "1 file was not uploaded",
      description: "Open “1 needs attention” in the header to see why.",
    });
  });

  it("names the trigger by its words, then what they are about (label in name)", () => {
    const name = (items: UploadView[]) => describeUploadsStatus(items) + uploadsStatusSuffix(items);
    expect(name([view("uploading"), view("waiting")])).toBe("Uploading 1 of 2 files");
    expect(name([view("uploading")])).toBe("Uploading 1 of 1 file");
    expect(name([view("failed"), view("failed"), view("uploaded")])).toBe(
      "2 need attention in uploads",
    );
    expect(name([view("uploaded")])).toBe("Uploads done");
    expect(name([])).toBe("");
  });

  it("counts the queue's failed rows for the toast", async () => {
    const h = harness();
    h.queue.add(plan("", "a.pdf", "b.pdf", "1.flac"), 10);
    expect(h.queue.failed).toBe(2);
  });

  it("describes replace_unavailable as a refusal with rclone", () => {
    expect(describeError(new ApiError(200, "replace_unavailable", "")).description).toMatch(
      /rclone/,
    );
  });

  it("names the limits the server gave", () => {
    const limits = { ...CONFIG.limits, maxKeyBytes: 512, maxSegmentBytes: 100 };
    expect(describeFailure({ code: "path_too_long" }, "a.flac", { ...CONFIG, limits })).toBe(
      "the path is over 512 bytes, or a name in it over 100",
    );
  });
});

/* ------------------------------------------------------ large queues -- */

describe("a large queue", () => {
  it("keeps each row's object while nothing on it changes", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac", "2.flac", "3.flac", "4.flac"), 10);
    const before = h.queue.getSnapshot();
    // Asked again with no change: the very same snapshot.
    expect(h.queue.getSnapshot()).toBe(before);
    await h.signAll(0);
    h.puts[0]?.onProgress(500);
    const after = h.queue.getSnapshot();
    expect(after).not.toBe(before);
    // 1.flac moved; the waiting 4.flac did not.
    expect(after.items[0]).not.toBe(before.items[0]);
    expect(after.items[3]).toBe(before.items[3]);
  });

  it("tells its listeners at most once every 100 ms, however much progress there is", async () => {
    vi.useFakeTimers({ now: NOW });
    const h = harness(() => Date.now());
    const listener = vi.fn();
    h.queue.subscribe(listener);
    h.queue.add(planUploads([picked("1.flac", 100_000)], "", CONFIG, noFolders), 10);
    await h.signAll(0);
    expect(listener).toHaveBeenCalledTimes(1);
    for (let loaded = 1000; loaded <= 50_000; loaded += 1000) {
      h.puts[0]?.onProgress(loaded);
    }
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(NOTIFY_EVERY_MS);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(percentOf(h.item("1.flac"))).toBe(50);
  });

  it("draws the rows that matter, and counts the rest", () => {
    const view = (id: number, state: UploadView["state"]): UploadView => ({
      id,
      key: `${id}.flac`,
      size: 1,
      loaded: 0,
      state,
    });
    const items = [
      ...Array.from({ length: 100 }, (_, i) => view(i, "uploaded")),
      view(100, "failed"),
      view(101, "canceled"),
      view(103, "uploading"),
      ...Array.from({ length: 80 }, (_, i) => view(200 + i, "waiting")),
    ];
    const { active, settled, rows, hidden } = shownRows(items, { finished: 10, waiting: 5 });
    // The file in flight at the top, then the next waiting, then the settled ones.
    expect(active.map((row) => row.id)).toEqual([103, 200, 201, 202, 203, 204]);
    expect(settled.map((row) => row.id)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101]);
    expect(rows).toEqual([...active, ...settled]);
    // A file waiting to be tried again, earlier in the queue, still goes below those in flight.
    expect(
      shownRows([view(1, "waiting"), view(2, "uploading"), view(3, "signing")]).active.map(
        (row) => row.id,
      ),
    ).toEqual([2, 3, 1]);
    expect(hidden).toEqual({ uploaded: 91, canceled: 0, waiting: 75 });
    expect(describeHidden(hidden)).toEqual({
      earlier: "91 more uploaded earlier",
      later: "and 75 more waiting",
    });
    expect(describeHidden({ uploaded: 1940, canceled: 1, waiting: 0 })).toEqual({
      earlier: "1,940 more uploaded and 1 canceled earlier",
      later: null,
    });
    expect(describeHidden({ uploaded: 0, canceled: 3, waiting: 0 }).earlier).toBe(
      "3 more canceled earlier",
    );
  });

  it("keeps every failure on screen", () => {
    const items = Array.from(
      { length: 300 },
      (_, i): UploadView => ({
        id: i,
        key: `${i}.flac`,
        size: 1,
        loaded: 0,
        state: "failed",
      }),
    );
    expect(shownRows(items).rows).toHaveLength(300);
  });
});

describe("the queue's end", () => {
  it("dispose cancels what is in flight and clears every row", async () => {
    const h = harness();
    const busy: boolean[] = [];
    h.queue.onBusyChange((value) => busy.push(value));
    h.queue.add(plan("", "1.flac", "2.flac", "3.flac", "4.flac"), 10);
    await h.signAll(0);
    h.queue.dispose();
    expect(h.puts.every((call) => call.signal.aborted)).toBe(true);
    expect(h.queue.getSnapshot()).toMatchObject({ items: [], busy: false });
    expect(busy).toEqual([true, false]);
    await h.putDone(0);
    expect(h.completes).toHaveLength(0);
    expect(h.signs).toHaveLength(1);
  });

  it("starts nothing once disposed, though a sign request was still on its way", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac", "2.flac"), 10);
    expect(h.signs).toHaveLength(1);
    h.queue.dispose();
    await h.signAll(0);
    await h.quiet();
    vi.advanceTimersByTime(REFRESH_EVERY_MS * 2);
    await tick();
    expect(h.puts).toHaveLength(0);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.completes).toHaveLength(0);
    expect(h.drained).toEqual([]);
    // Nor does a queue that ended take new files.
    h.queue.add(plan("", "3.flac"), 10);
    expect(h.signs).toHaveLength(1);
  });

  it("reports nothing it held once disposed, and refreshes nothing", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac", "2.flac"), 10);
    await h.signAll(0);
    await h.putDone(0);
    const refreshed = h.refresh.mock.calls.length;
    h.queue.dispose();
    await h.putDone(1);
    await h.quiet();
    vi.advanceTimersByTime(REFRESH_EVERY_MS * 2);
    expect(h.completes).toHaveLength(0);
    expect(h.refresh.mock.calls.length).toBe(refreshed);
  });

  it("takes a retry's exists of the same size as its own upload, whose answer was lost", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac"), 10);
    await h.signAll(0);
    // The answer is lost: a network error after R2 took the file.
    await h.putDone(0, 0);
    h.signs[1]?.resolve({
      uploads: [
        {
          key: "1.flac",
          error: "exists",
          existing: { size: 1000, uploadedAt: "2026-10-02T12:00:00Z" },
        },
      ],
      clock: clock(),
    });
    await tick();
    expect(h.item("1.flac").state).toBe("uploaded");
    await h.quiet();
    expect(h.completes.map((call) => call.keys)).toEqual([["1.flac"]]);
  });

  it("fails a retry's exists of another size, but still reports what may be its upload", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac"), 10);
    await h.signAll(0);
    await h.putDone(0, 0);
    h.signs[1]?.resolve({
      uploads: [
        {
          key: "1.flac",
          error: "exists",
          existing: { size: 7, uploadedAt: "2026-10-02T12:00:00Z" },
        },
      ],
      clock: clock(),
    });
    await tick();
    expect(h.item("1.flac")).toMatchObject({ state: "failed", failure: { code: "exists_now" } });
    await h.quiet();
    expect(h.completes.map((call) => call.keys)).toEqual([["1.flac"]]);
  });

  it("reports no file that exists and that it never sent", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac"), 10);
    h.signs[0]?.resolve({
      uploads: [
        {
          key: "1.flac",
          error: "exists",
          existing: { size: 1000, uploadedAt: "2026-10-02T12:00:00Z" },
        },
      ],
      clock: clock(),
    });
    await tick();
    await h.quiet();
    expect(h.item("1.flac").state).toBe("failed");
    expect(h.completes).toHaveLength(0);
  });

  it("plans a large pick in slices, drawing the page between them, to the same plan", async () => {
    const files = Array.from({ length: 600 }, (_, i) =>
      picked(`${600 - i}.flac`, 10, `Album/${600 - i}.flac`),
    );
    let yields = 0;
    const sliced = await planUploadsInSlices(files, "", CONFIG, noFolders, async () => {
      yields++;
    });
    expect(yields).toBe(Math.ceil(600 / PLAN_SLICE));
    expect(sliced).toEqual(planUploads(files, "", CONFIG, noFolders));
    expect(sliced[0]?.key).toBe("Album/1.flac");
  });

  it("finds nothing to upload in a picked folder that is hidden", () => {
    expect(
      planUploads(
        [picked("01.flac", 10, ".music/01.flac"), picked("02.flac", 10, ".music/02.flac")],
        "",
        CONFIG,
        noFolders,
      ),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------- xhrPut -- */

describe("xhrPut", () => {
  /** A stand-in for the browser's `XMLHttpRequest`, recording what the queue does with it. */
  class FakeXhr {
    static last: FakeXhr | undefined;
    method = "";
    url = "";
    headers: Record<string, string> = {};
    body: unknown;
    status = 0;
    aborted = false;
    upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() {
      FakeXhr.last = this;
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(body: unknown) {
      this.body = body;
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  }

  const upload = url("A/01 Song.flac") as PresignedUpload;

  function start(signal = new AbortController().signal) {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress: number[] = [];
    const body = new Blob(["abc"]);
    const answer = xhrPut(upload, body, (loaded) => progress.push(loaded), signal);
    const xhr = FakeXhr.last;
    if (!xhr) {
      throw new Error("no XMLHttpRequest made");
    }
    return { answer, xhr, progress, body };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the file with exactly the signed method, URL and headers", async () => {
    const { answer, xhr, progress, body } = start();
    expect([xhr.method, xhr.url]).toEqual(["PUT", upload.url]);
    expect(xhr.headers).toEqual(upload.headers);
    expect(xhr.body).toBe(body);
    xhr.upload.onprogress?.({ loaded: 2 });
    expect(progress).toEqual([2]);
    xhr.status = 200;
    xhr.onload?.();
    expect(await answer).toBe(200);
  });

  it("answers the bucket's status, and 0 for a network error or a timeout", async () => {
    const refused = start();
    refused.xhr.status = 412;
    refused.xhr.onload?.();
    expect(await refused.answer).toBe(412);
    const lost = start();
    lost.xhr.onerror?.();
    expect(await lost.answer).toBe(0);
    const slow = start();
    slow.xhr.ontimeout?.();
    expect(await slow.answer).toBe(0);
  });

  it("aborts the request when the signal does, and answers 0", async () => {
    const controller = new AbortController();
    const { answer, xhr } = start(controller.signal);
    controller.abort();
    expect(xhr.aborted).toBe(true);
    expect(await answer).toBe(0);
  });
});
