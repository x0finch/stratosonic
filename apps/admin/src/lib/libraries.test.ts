import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  connectLibrary,
  fetchLibraries,
  type Library,
  removeLibrary,
  subsonicUsersQuery,
  testLibrary,
  updateLibrary,
} from "@/lib/api";
import { describeConnectionFailure, describeError } from "@/lib/errors";
import { filesConfigQuery } from "@/lib/files";
import {
  BUCKET_CHANGE_NOTE,
  bucketMoves,
  connectedNotice,
  corsCommands,
  corsJson,
  corsRule,
  countOf,
  LIBRARIES_POLL_MS,
  librariesQuery,
  librariesRefetchInterval,
  libraryBadges,
  libraryChanges,
  libraryFieldErrors,
  libraryFieldOf,
  libraryWriteOptions,
  removable,
  removeConsequences,
  removedNotice,
  savedNotice,
  scanPending,
  testNotice,
} from "@/lib/libraries";
import { LIBRARY_KEY } from "@/lib/overview";

// Phase 2's rule, which every bucket's CORS rule repeats (apps/server README, "File uploads").
import example from "../../../server/r2-cors.example.json?raw";

/** Library 2, "Archive", as the spec's example lists it, scanned and idle. */
function library(overrides: Partial<Library> = {}): Library {
  return {
    id: 2,
    name: "Archive",
    kind: "s3",
    accountId: "0123456789abcdef0123456789abcdef",
    bucket: "archive",
    accessKeyIdHint: "…3F9A",
    writable: true,
    defaultNewUsers: false,
    state: "active",
    lastScanStartedAt: "2026-10-04T10:00:00.000Z",
    lastScanAt: "2026-10-04T10:05:00.000Z",
    lastScanError: null,
    counts: { artists: 120, albums: 210, tracks: 2034, sizeBytes: 61_234_567_890, durationSec: 1 },
    ...overrides,
  };
}

/** Library 1, the bound bucket. */
function bound(overrides: Partial<Library> = {}): Library {
  return library({
    id: 1,
    name: "Music Library",
    kind: "r2-binding",
    bucket: "navidrome",
    accessKeyIdHint: null,
    ...overrides,
  });
}

function answer(status: number, body: unknown) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const WRITE_HEADERS = { Accept: "application/json", "Content-Type": "application/json" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the Libraries API client", () => {
  it("lists the libraries", async () => {
    const fetch = answer(200, { libraries: [bound(), library()], defaultAccountId: null });

    expect(await fetchLibraries()).toEqual({
      libraries: [bound(), library()],
      defaultAccountId: null,
    });
    expect(fetch).toHaveBeenCalledWith("/api/libraries", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      body: undefined,
    });
  });

  it("connects, edits, tests and removes with JSON bodies", async () => {
    const request = {
      name: "Archive",
      accountId: "0123456789abcdef0123456789abcdef",
      bucket: "archive",
      accessKeyId: "id",
      secretAccessKey: "secret",
      defaultNewUsers: true,
    };
    let fetch = answer(201, { library: library(), scan: "started" });
    expect(await connectLibrary(request)).toEqual({ library: library(), scan: "started" });
    expect(fetch).toHaveBeenCalledWith("/api/libraries", {
      method: "POST",
      credentials: "same-origin",
      headers: WRITE_HEADERS,
      body: JSON.stringify(request),
    });

    fetch = answer(200, { library: library({ name: "Old" }), scan: null });
    expect((await updateLibrary(2, { name: "Old" })).library.name).toBe("Old");
    expect(fetch).toHaveBeenCalledWith("/api/libraries/2", {
      method: "PATCH",
      credentials: "same-origin",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ name: "Old" }),
    });

    fetch = answer(200, { ok: true, writable: false });
    expect(await testLibrary(2)).toEqual({ ok: true, writable: false });
    expect(fetch).toHaveBeenCalledWith("/api/libraries/2/test", {
      method: "POST",
      credentials: "same-origin",
      headers: WRITE_HEADERS,
      body: "{}",
    });

    fetch = answer(200, { removed: { tracks: 2034, albums: 210, playlists: 3 } });
    expect(await removeLibrary(2)).toEqual({ tracks: 2034, albums: 210, playlists: 3 });
    expect(fetch).toHaveBeenCalledWith("/api/libraries/2", {
      method: "DELETE",
      credentials: "same-origin",
      headers: WRITE_HEADERS,
      body: "{}",
    });
  });

  it("keeps a failed connect's reason", async () => {
    answer(422, { error: "connection_failed", reason: "bucket_not_found" });
    const error = await connectLibrary({
      name: "Archive",
      accountId: "0123456789abcdef0123456789abcdef",
      bucket: "archive",
      accessKeyId: "id",
      secretAccessKey: "secret",
      defaultNewUsers: false,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect([(error as ApiError).code, (error as ApiError).reason]).toEqual([
      "connection_failed",
      "bucket_not_found",
    ]);
  });
});

describe("describeError for the Libraries API", () => {
  it("has its own words for every new code", () => {
    const titles = new Set<string>();
    for (const code of [
      "name_taken",
      "already_connected",
      "invalid_account_id",
      "invalid_bucket",
      "default_library",
      "removing",
    ]) {
      const { title, description } = describeError(new ApiError(409, code, ""));
      expect(title).not.toBe("Something went wrong");
      expect(description).not.toBe("");
      titles.add(title);
    }
    expect(titles.size).toBe(6);
  });

  it("says why a connection failed, by its reason", () => {
    const failed = (reason?: string) =>
      describeError(new ApiError(422, "connection_failed", "", undefined, reason)).title;

    expect(failed("auth")).toBe("The key was refused");
    expect(failed("bucket_not_found")).toBe("The bucket was not found");
    expect(failed("unavailable")).toBe("The bucket did not answer");
    expect(failed("throttled")).toBe("The bucket is busy");
    // A reason this console does not know yet, or none, is a bucket that did not answer.
    expect(failed("new_reason")).toBe("The bucket did not answer");
    expect(failed()).toBe("The bucket did not answer");
    expect(describeConnectionFailure(null).title).toBe("The bucket did not answer");
  });
});

describe("the polling rule", () => {
  const list = (...libraries: Library[]) => ({ libraries, defaultAccountId: null });

  it("does not poll while nothing moves", () => {
    expect(librariesRefetchInterval(undefined)).toBe(false);
    expect(librariesRefetchInterval(list(bound(), library()))).toBe(false);
  });

  it("polls every 30 s while a library is being removed", () => {
    expect(librariesRefetchInterval(list(bound(), library({ state: "removing" })))).toBe(30_000);
    expect(LIBRARIES_POLL_MS).toBe(30_000);
  });

  it("polls while a pass is in a library, or has yet to reach a new one", () => {
    const entered = library({ lastScanStartedAt: "2026-10-04T11:00:00.000Z" });
    expect(scanPending(entered)).toBe(true);
    expect(librariesRefetchInterval(list(bound(), entered))).toBe(30_000);

    const connected = library({ lastScanStartedAt: null, lastScanAt: null });
    expect(scanPending(connected)).toBe(true);
    expect(librariesRefetchInterval(list(bound(), connected))).toBe(30_000);
  });

  it("does not poll for a library the last pass skipped, or one entered and left in one step", () => {
    expect(
      scanPending(
        library({ lastScanStartedAt: "2026-10-04T11:00:00.000Z", lastScanError: "auth" }),
      ),
    ).toBe(false);
    expect(scanPending(library({ lastScanAt: null, lastScanError: "auth" }))).toBe(false);
    expect(
      scanPending(
        library({
          lastScanStartedAt: "2026-10-04T11:00:00.000Z",
          lastScanAt: "2026-10-04T11:00:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  it("is the query's interval, fresh for 30 s and never in a hidden tab", () => {
    expect(librariesQuery.staleTime).toBe(30_000);
    expect(librariesQuery.refetchIntervalInBackground).toBe(false);
  });
});

describe("libraryBadges", () => {
  it("marks the bound bucket, and nothing on a healthy connected library", () => {
    expect(libraryBadges(bound())).toEqual([{ label: "Bound bucket" }]);
    expect(libraryBadges(library())).toEqual([]);
  });

  it("marks a read-only library", () => {
    expect(libraryBadges(library({ writable: false }))).toEqual([{ label: "Read only" }]);
  });

  it("marks a library being removed, and nothing else about it", () => {
    expect(
      libraryBadges(library({ state: "removing", writable: false, lastScanError: "auth" })),
    ).toEqual([{ label: "Removing" }]);
  });

  it("says why the last scan failed, in the tooltip", () => {
    const reason = (lastScanError: string) =>
      libraryBadges(library({ lastScanError })).find((badge) => badge.label === "Scan failed")
        ?.reason;

    expect(reason("auth")).toBe("The key was refused");
    expect(reason("bucket_not_found")).toBe("The bucket was not found");
    expect(reason("unavailable")).toBe("The bucket did not answer");
    expect(reason("something_new")).toBe("The bucket did not answer");
    expect(libraryBadges(library({ writable: false, lastScanError: "auth" }))).toEqual([
      { label: "Read only" },
      { label: "Scan failed", reason: "The key was refused" },
    ]);
  });

  it("offers removal on any active library but the bound bucket", () => {
    expect(removable(bound())).toBe(false);
    expect(removable(library())).toBe(true);
    expect(removable(library({ state: "removing" }))).toBe(false);
  });
});

describe("the CORS rule", () => {
  it("is Phase 2's rule with the console's origin", () => {
    expect(corsRule("https://music.example.com")).toEqual({
      rules: [
        {
          allowed: {
            origins: ["https://music.example.com"],
            methods: ["PUT"],
            headers: ["content-type", "if-none-match"],
          },
          exposeHeaders: ["ETag"],
          maxAgeSeconds: 3600,
        },
      ],
    });
    expect(JSON.parse(corsJson("http://localhost:5173"))).toEqual(
      corsRule("http://localhost:5173"),
    );
  });

  it("is written as the server's example file is", () => {
    expect(corsJson("https://stratosonic.<your-subdomain>.workers.dev")).toBe(example.trimEnd());
  });

  it("names the bucket in both commands", () => {
    expect(corsCommands("archive")).toEqual({
      set: "pnpm exec wrangler r2 bucket cors set archive --file r2-cors.json",
      list: "pnpm exec wrangler r2 bucket cors list archive",
    });
    expect(corsCommands(null).set).toBe(
      "pnpm exec wrangler r2 bucket cors set <bucket> --file r2-cors.json",
    );
  });
});

describe("the connect and edit forms' field errors", () => {
  const ALL = ["name", "accountId", "bucket", "accessKeyId", "secretAccessKey"] as const;
  const refused = (code: string, reason?: string) =>
    new ApiError(code === "connection_failed" ? 422 : 409, code, "", undefined, reason);

  it("puts every field's refusal beside its field", () => {
    expect(libraryFieldErrors(refused("name_taken"), ALL)).toEqual({
      name: "The name is taken.",
    });
    expect(libraryFieldErrors(refused("invalid_account_id"), ALL)).toEqual({
      accountId: "The account ID is not valid.",
    });
    expect(libraryFieldErrors(refused("invalid_bucket"), ALL)).toEqual({
      bucket: "The bucket name is not valid.",
    });
    expect(libraryFieldErrors(refused("already_connected"), ALL)).toEqual({
      bucket: "The bucket is already connected.",
    });
    expect(libraryFieldErrors(refused("connection_failed", "bucket_not_found"), ALL)).toEqual({
      bucket: "The bucket was not found.",
    });
    // A refused key belongs to the pair, beneath its second field.
    expect(libraryFieldErrors(refused("connection_failed", "auth"), ALL)).toEqual({
      secretAccessKey: "The key was refused.",
    });
  });

  it("leaves every other refusal to a toast", () => {
    for (const error of [
      refused("invalid_request"),
      refused("connection_failed", "unavailable"),
      refused("connection_failed", "throttled"),
      refused("connection_failed"),
      refused("removing"),
      refused("default_library"),
      new Error("boom"),
    ]) {
      expect(libraryFieldOf(error)).toBeUndefined();
      expect(libraryFieldErrors(error, ALL)).toBeUndefined();
    }
  });

  it("leaves a refusal for a field the form does not show to a toast", () => {
    // An edit of the bucket only, whose stored key the test refused.
    expect(
      libraryFieldErrors(refused("connection_failed", "auth"), ["name", "accountId", "bucket"]),
    ).toBeUndefined();
    // Library 1's form shows its name only.
    expect(libraryFieldErrors(refused("invalid_bucket"), ["name"])).toBeUndefined();
    expect(libraryFieldErrors(refused("name_taken"), ["name"])).toEqual({
      name: "The name is taken.",
    });
  });
});

describe("libraryChanges", () => {
  const unchanged = {
    name: "Archive",
    defaultNewUsers: false,
    accountId: "0123456789abcdef0123456789abcdef",
    bucket: "archive",
    replaceCredentials: false,
    accessKeyId: "",
    secretAccessKey: "",
  };

  it("sends nothing when nothing changed, spaces around the name included", () => {
    expect(libraryChanges(library(), unchanged)).toBeNull();
    expect(libraryChanges(library(), { ...unchanged, name: "  Archive " })).toBeNull();
  });

  it("sends only what changed, and the keys together", () => {
    expect(libraryChanges(library(), { ...unchanged, name: "Old music " })).toEqual({
      name: "Old music",
    });
    expect(
      libraryChanges(library(), { ...unchanged, defaultNewUsers: true, bucket: " archive-2 " }),
    ).toEqual({ defaultNewUsers: true, bucket: "archive-2" });
    expect(
      libraryChanges(library(), {
        ...unchanged,
        replaceCredentials: true,
        accessKeyId: "id",
        secretAccessKey: "secret",
      }),
    ).toEqual({ accessKeyId: "id", secretAccessKey: "secret" });
  });

  it("sends library 1 its name and default only", () => {
    expect(
      libraryChanges(bound(), {
        ...unchanged,
        name: "Music",
        accountId: "ffffffffffffffffffffffffffffffff",
        bucket: "elsewhere",
        replaceCredentials: true,
        accessKeyId: "id",
        secretAccessKey: "secret",
      }),
    ).toEqual({ name: "Music" });
  });

  it("shows the bucket-change note only when the account or bucket moves", () => {
    expect(bucketMoves(library(), unchanged)).toBe(false);
    expect(bucketMoves(library(), { ...unchanged, bucket: "archive-2" })).toBe(true);
    expect(
      bucketMoves(library(), { ...unchanged, accountId: "ffffffffffffffffffffffffffffffff" }),
    ).toBe(true);
    // A field being retyped says nothing yet.
    expect(bucketMoves(library(), { ...unchanged, bucket: "" })).toBe(false);
    expect(bucketMoves(bound(), { ...unchanged, bucket: "elsewhere" })).toBe(false);
    expect(BUCKET_CHANGE_NOTE).toBe(
      "Tracks that are not in the new bucket leave the library at the next scan.",
    );
  });
});

describe("what the dialogs and toasts say", () => {
  it("counts in the singular for one", () => {
    expect(countOf(1, "track")).toBe("1 track");
    expect(countOf(2034, "track")).toBe("2,034 tracks");
    expect(countOf(0, "playlist")).toBe("0 playlists");
  });

  it("says what a removal takes, and that the bucket's files stay", () => {
    expect(removeConsequences(library())).toBe(
      "Its 2,034 tracks, 210 albums and the playlists stored in its bucket leave the library, with every star, rating, play count and bookmark on them. The files in the bucket are not touched. Connecting the bucket again makes a new library, and none of this comes back.",
    );
    expect(removedNotice(library(), { tracks: 2034, albums: 210, playlists: 3 })).toEqual({
      title: "Removed Archive",
      description:
        "Its 2,034 tracks, 210 albums and 3 playlists leave the library as the scan cleans up. The files in the bucket are not touched.",
    });
  });

  it("says the first scan has started", () => {
    expect(connectedNotice(library(), "started")).toEqual({
      title: "Connected Archive",
      description: "Its first scan has started.",
    });
    expect(connectedNotice(library(), "running").description).toBe(
      "The scan in progress includes it.",
    );
    expect(connectedNotice(library(), null).description).toBe(
      "The next scheduled scan indexes it.",
    );
  });

  it("says what an edit changed", () => {
    expect(savedNotice(library(), library({ name: "Old" }), { name: "Old" }, null)).toEqual({
      title: "Saved Old",
      description: "Subsonic clients now show Archive as Old.",
    });
    expect(
      savedNotice(library(), library({ bucket: "archive-2" }), { bucket: "archive-2" }, "started")
        .description,
    ).toBe("A scan of archive-2 has started.");
    expect(
      savedNotice(library(), library(), { accessKeyId: "id", secretAccessKey: "s" }, null)
        .description,
    ).toBe("Its new key is stored.");
    expect(
      savedNotice(library(), library({ defaultNewUsers: true }), { defaultNewUsers: true }, null)
        .description,
    ).toBe("New Subsonic users get access to it.");
  });

  it("says what a connection test found", () => {
    expect(testNotice(library(), { ok: true, writable: true }).title).toBe(
      "Archive: connected, read and write",
    );
    expect(testNotice(library(), { ok: true, writable: false }).title).toBe(
      "Archive: connected, read only",
    );
    expect(testNotice(library(), { ok: false, reason: "auth" })).toEqual({
      title: "Archive: the key was refused",
      description: describeConnectionFailure("auth").description,
      failed: true,
    });
    expect(testNotice(bound(), { ok: true, writable: true, uploads: false }).description).toContain(
      "Uploads need R2 API credentials",
    );
    expect(testNotice(bound(), { ok: true, writable: true, uploads: true }).description).toBe(
      "The Worker reads the bucket, and uploads are configured.",
    );
  });
});

describe("libraryWriteOptions", () => {
  function harness(succeeded: { failed?: boolean }, fieldShown?: (error: unknown) => boolean) {
    const queryClient = new QueryClient();
    const notices: unknown[][] = [];
    let settle: { resolve(value: string): void; reject(error: unknown): void } | undefined;
    const options = libraryWriteOptions<string, string>(
      queryClient,
      {
        success: (title) => notices.push(["success", title]),
        failure: (title) => notices.push(["failure", title]),
        error: (error) => notices.push(["error", (error as ApiError).code]),
      },
      {
        mutationFn: () =>
          new Promise<string>((resolve, reject) => {
            settle = { resolve, reject };
          }),
        succeeded: (data) => ({ title: data, description: "", ...succeeded }),
        fieldShown,
      },
    );
    const observer = new MutationObserver(queryClient, options);
    const done = observer.mutate("Archive").catch(() => undefined);
    const started = new Promise((resolve) => setTimeout(resolve, 0));
    return { queryClient, notices, done, started, settle: () => settle };
  }

  it("raises a success or a failure toast from the answer", async () => {
    let write = harness({});
    await write.started;
    write.settle()?.resolve("Archive: connected, read and write");
    await write.done;
    expect(write.notices).toEqual([["success", "Archive: connected, read and write"]]);

    write = harness({ failed: true });
    await write.started;
    write.settle()?.resolve("Archive: the key was refused");
    await write.done;
    expect(write.notices).toEqual([["failure", "Archive: the key was refused"]]);
  });

  it("leaves a field's refusal to the dialog, and toasts the rest", async () => {
    let write = harness({}, (error) => (error as ApiError).code === "name_taken");
    await write.started;
    write.settle()?.reject(new ApiError(409, "name_taken", ""));
    await write.done;
    expect(write.notices).toEqual([]);

    write = harness({}, () => false);
    await write.started;
    write.settle()?.reject(new ApiError(409, "removing", ""));
    await write.done;
    expect(write.notices).toEqual([["error", "removing"]]);
  });

  it("keeps no secret key in the mutation cache once nothing shows the write", async () => {
    const write = harness({});
    expect(write.queryClient.getMutationCache().getAll()[0]?.options.gcTime).toBe(0);
    await write.started;
    write.settle()?.resolve("Archive");
    await write.done;
  });

  it("reads the libraries, the files configuration, the Overview's library and the users again", async () => {
    const write = harness({});
    const invalidate = vi.spyOn(write.queryClient, "invalidateQueries");
    write.queryClient.setQueryData(librariesQuery.queryKey, {
      libraries: [],
      defaultAccountId: null,
    });
    await write.started;
    write.settle()?.reject(new ApiError(500, "internal", ""));
    await write.done;

    expect(write.queryClient.getQueryState(librariesQuery.queryKey)?.isInvalidated).toBe(true);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      librariesQuery.queryKey,
      filesConfigQuery.queryKey,
      LIBRARY_KEY,
      subsonicUsersQuery.queryKey,
    ]);
  });
});
