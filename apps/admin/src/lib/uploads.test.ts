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
  checkUpload,
  describeFailure,
  describeHidden,
  describeQueue,
  EXPIRY_MARGIN_MS,
  NOTIFY_EVERY_MS,
  notUploadedToast,
  type PickedFile,
  type PlannedUpload,
  percentOf,
  planUploads,
  REFRESH_EVERY_MS,
  type RunSummary,
  shownRows,
  UploadQueue,
  type UploadView,
  uploadedToast,
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

/** A queue whose every call waits for the test to answer it. */
function harness(now: () => number = () => NOW) {
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
  return {
    queue,
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
    expect(h.drained).toEqual([{ uploaded: 0, notUploaded: 1, conflicts: 0, scanUnknown: false }]);
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

  it("reports a sign request's uploads together, once all of them are done", async () => {
    const h = harness();
    h.queue.add(plan("A/", "1.flac", "2.flac", "3.flac"), 10);
    await h.signAll(0);
    await h.putDone(0);
    await h.putDone(1, 500);
    expect(h.completes).toHaveLength(0);
    await h.putDone(2);
    expect(h.completes.map((call) => call.keys)).toEqual([["A/1.flac", "A/3.flac"]]);
    // The queue's run lasts until the report is answered.
    expect(h.drained).toEqual([]);
    await h.completeDone(0);
    expect(h.queue.getSnapshot().schedule?.scan).toEqual(SCHEDULED);
    expect(h.drained).toEqual([{ uploaded: 2, notUploaded: 1, conflicts: 0, scanUnknown: false }]);
  });

  it("makes one complete request per sign request that uploaded something", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac", "2.flac", "3.flac", "4.flac"), 10);
    await h.signAll(0);
    for (const index of [0, 1, 2]) {
      await h.putDone(index);
    }
    await h.signAll(1);
    await h.putDone(3);
    expect(h.signs.map((call) => call.files.length)).toEqual([3, 1]);
    expect(h.completes.map((call) => call.keys)).toEqual([
      ["1.flac", "2.flac", "3.flac"],
      ["4.flac"],
    ]);
  });

  it("completes with the key the server signed, not the one asked for", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac"), 10);
    h.signs[0]?.resolve({ uploads: [url("Stored/1.flac")], clock: clock() });
    await tick();
    await h.putDone(0);
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

  describe("Already exists", () => {
    async function conflicted() {
      const h = harness();
      h.queue.add(plan("", "1.flac", "2.flac", "3.flac"), 10);
      h.signs[0]?.resolve({
        uploads: [
          {
            key: "1.flac",
            error: "exists",
            existing: { size: 5, uploadedAt: "2026-01-01T00:00:00Z" },
          },
          url("2.flac"),
          {
            key: "3.flac",
            error: "exists",
            existing: { size: 6, uploadedAt: "2026-01-01T00:00:00Z" },
          },
        ],
        clock: clock(),
      });
      await tick();
      return h;
    }

    it("is a state with what is there, and the run says so", async () => {
      const h = await conflicted();
      expect(h.item("1.flac")).toMatchObject({ state: "exists", existing: { size: 5 } });
      await h.putDone(0);
      await h.completeDone(0);
      expect(h.drained).toEqual([
        { uploaded: 1, notUploaded: 2, conflicts: 2, scanUnknown: false },
      ]);
      expect(h.queue.getSnapshot().busy).toBe(false);
    });

    it("Replace signs again with overwrite: true, only when asked", async () => {
      const h = await conflicted();
      expect(h.signs).toHaveLength(1);
      const id = h.item("1.flac").id;
      h.queue.replace(id);
      expect(h.signs[1]?.files).toEqual([{ key: "1.flac", size: 1000, overwrite: true }]);
    });

    it("Replace all signs every conflict again, and Skip leaves one", async () => {
      const h = await conflicted();
      h.queue.skip(h.item("3.flac").id);
      expect(h.item("3.flac").state).toBe("skipped");
      h.queue.replaceAll();
      expect(h.signs[1]?.files).toEqual([{ key: "1.flac", size: 1000, overwrite: true }]);
      expect(h.item("3.flac").state).toBe("skipped");
    });

    it("Skip all leaves every conflict", async () => {
      const h = await conflicted();
      h.queue.skipAll();
      expect(h.states()).toEqual(["skipped", "uploading", "skipped"]);
    });

    it("a 412 from R2 is Already exists too", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac"), 10);
      await h.signAll(0);
      await h.putDone(0, 412);
      expect(h.item("1.flac").state).toBe("exists");
      expect(h.signs).toHaveLength(1);
      expect(h.completes).toHaveLength(0);
    });

    it("a Replace the server cannot spell is Failed, with rclone named", async () => {
      const h = await conflicted();
      h.queue.replace(h.item("1.flac").id);
      h.signs[1]?.resolve({
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
      expect(h.drained).toEqual([
        { uploaded: 0, notUploaded: 4, conflicts: 0, scanUnknown: false },
      ]);
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

    it("drops a file being signed, and reports the rest of its request", async () => {
      const h = harness();
      h.queue.add(plan("", "1.flac", "2.flac"), 10);
      h.queue.cancel(h.item("1.flac").id);
      await h.signAll(0);
      expect(h.puts.map((call) => call.upload)).toEqual([url("2.flac")]);
      await h.putDone(0);
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

  it("reports the uploads waiting on their request at pagehide", async () => {
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
    expect(h.completes.map((call) => call.keys)).toEqual([["1.flac"], ["2.flac"]]);
    stop();
  });

  it("says when the scan is unknown: a null schedule, or a failed report", async () => {
    const h = harness();
    h.queue.add(plan("", "1.flac"), 10);
    await h.signAll(0);
    await h.putDone(0);
    await h.completeDone(0, null);
    expect(h.drained.at(-1)?.scanUnknown).toBe(true);

    h.queue.add(plan("", "2.flac"), 10);
    await h.signAll(1);
    await h.putDone(1);
    h.completes[1]?.reject(new ApiError(500, "internal", ""));
    await tick();
    expect(h.drained.at(-1)).toEqual({
      uploaded: 1,
      notUploaded: 0,
      conflicts: 0,
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
      ["2.flac", "exists"],
      ["3.flac", "uploading"],
      ["4.flac", "signing"],
    ]);
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
      describeQueue([
        view("uploaded"),
        view("uploading"),
        view("failed"),
        view("skipped"),
        view("canceled"),
      ]),
    ).toBe("1 of 3 uploaded");
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
    expect(
      describeFailure(
        { code: "sign_failed", error: new ApiError(0, "network", "") },
        "a.flac",
        CONFIG,
      ),
    ).toBe("the server could not be reached");
  });

  it("toasts what a run did", () => {
    const summary = { uploaded: 12, notUploaded: 2, conflicts: 1, scanUnknown: false };
    expect(uploadedToast(summary)).toEqual({
      title: "Uploaded 12 files",
      description: "Tracks join the library at the next scan.",
    });
    expect(uploadedToast({ ...summary, uploaded: 1, scanUnknown: true })).toEqual({
      title: "Uploaded 1 file",
      description: "The next scheduled scan will index it.",
    });
    expect(notUploadedToast(summary)).toEqual({
      title: "2 files were not uploaded",
      description: "Uploads lists why. Replace or skip the files that already exist.",
    });
    expect(notUploadedToast({ ...summary, notUploaded: 1, conflicts: 0 }).title).toBe(
      "1 file was not uploaded",
    );
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
      view(101, "exists"),
      view(102, "skipped"),
      view(103, "uploading"),
      ...Array.from({ length: 80 }, (_, i) => view(200 + i, "waiting")),
    ];
    const { rows, hidden } = shownRows(items, { finished: 10, waiting: 5 });
    expect(rows.map((row) => row.id)).toEqual([
      91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 200, 201, 202, 203, 204,
    ]);
    expect(hidden).toEqual({ uploaded: 91, skipped: 0, canceled: 0, waiting: 75 });
    expect(describeHidden(hidden)).toEqual(["and 91 more uploaded", "and 75 more waiting"]);
    expect(describeHidden({ uploaded: 1940, skipped: 2, canceled: 1, waiting: 0 })).toEqual([
      "and 1,940 more uploaded, 2 skipped and 1 canceled",
    ]);
    expect(describeHidden({ uploaded: 0, skipped: 3, canceled: 0, waiting: 0 })).toEqual([
      "and 3 more skipped",
    ]);
  });

  it("keeps every failure and conflict on screen", () => {
    const items = Array.from(
      { length: 300 },
      (_, i): UploadView => ({
        id: i,
        key: `${i}.flac`,
        size: 1,
        loaded: 0,
        state: i % 2 ? "failed" : "exists",
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

  it("reports a skipped file whose earlier upload may have landed with its answer lost", async () => {
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
    expect(h.item("1.flac").state).toBe("exists");
    h.queue.skip(h.item("1.flac").id);
    expect(h.completes.map((call) => call.keys)).toEqual([["1.flac"]]);
  });

  it("reports no skipped file it never sent", async () => {
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
    h.queue.skip(h.item("1.flac").id);
    expect(h.completes).toHaveLength(0);
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
