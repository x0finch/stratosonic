import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  createSubsonicUser,
  deleteSubsonicUser,
  fetchSubsonicUsers,
  type SubsonicUser,
  type SubsonicUserList,
  setSubsonicPassword,
  subsonicUsersQuery,
  updateSubsonicUser,
} from "@/lib/api";
import { describeError } from "@/lib/errors";
import { fieldErrorsFrom } from "@/lib/field-errors";
import {
  ADMIN_HELP,
  ADMIN_LIBRARIES,
  adminRequired,
  afterUserWrite,
  defaultLibraryIds,
  deleteConsequences,
  formatDay,
  LIBRARIES_REQUIRED,
  librariesError,
  librariesLabel,
  showsLibraries,
  USER_FIELDS_BY_CODE,
  userChanges,
  userNamesMatch,
  userWriteOptions,
} from "@/lib/subsonic-users";

function user(overrides: Partial<SubsonicUser> = {}): SubsonicUser {
  return {
    id: "u-1",
    username: "alice",
    isAdmin: false,
    createdAt: "2026-09-30T12:00:00.000Z",
    updatedAt: "2026-09-30T12:00:00.000Z",
    lastAccessAt: null,
    playlistCount: 0,
    libraryIds: [1],
    ...overrides,
  };
}

const LIBRARIES = [
  { id: 1, name: "Music Library" },
  { id: 2, name: "Archive" },
  { id: 3, name: "Live recordings" },
];

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

describe("the Subsonic users API client", () => {
  it("lists the users, and the libraries a user may be given", async () => {
    const fetch = answer(200, { users: [user()], libraries: LIBRARIES });

    expect(await fetchSubsonicUsers()).toEqual({ users: [user()], libraries: LIBRARIES });
    expect(fetch).toHaveBeenCalledWith("/api/subsonic-users", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      body: undefined,
    });
  });

  it("creates, edits and sets a password with JSON bodies", async () => {
    let fetch = answer(201, { user: user({ isAdmin: true }) });
    expect(await createSubsonicUser({ username: "alice", password: "pw", isAdmin: true })).toEqual(
      user({ isAdmin: true }),
    );
    expect(fetch).toHaveBeenCalledWith("/api/subsonic-users", {
      method: "POST",
      credentials: "same-origin",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ username: "alice", password: "pw", isAdmin: true }),
    });

    fetch = answer(200, { user: user({ username: "Alice" }) });
    expect((await updateSubsonicUser("u-1", { username: "Alice" })).username).toBe("Alice");
    expect(fetch).toHaveBeenCalledWith("/api/subsonic-users/u-1", {
      method: "PATCH",
      credentials: "same-origin",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ username: "Alice" }),
    });

    fetch = answer(201, { user: user({ libraryIds: [2] }) });
    await createSubsonicUser({ username: "bob", password: "pw", isAdmin: false, libraryIds: [2] });
    expect(fetch).toHaveBeenCalledWith(
      "/api/subsonic-users",
      expect.objectContaining({
        body: JSON.stringify({ username: "bob", password: "pw", isAdmin: false, libraryIds: [2] }),
      }),
    );

    fetch = answer(200, { user: user({ libraryIds: [1, 3] }) });
    await updateSubsonicUser("u-1", { libraryIds: [1, 3] });
    expect(fetch).toHaveBeenCalledWith(
      "/api/subsonic-users/u-1",
      expect.objectContaining({ body: JSON.stringify({ libraryIds: [1, 3] }) }),
    );

    fetch = answer(200, { ok: true });
    await setSubsonicPassword("u-1", "new");
    expect(fetch).toHaveBeenCalledWith("/api/subsonic-users/u-1/password", {
      method: "PUT",
      credentials: "same-origin",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ password: "new" }),
    });
  });

  it("deletes with an empty JSON object, as every write sends", async () => {
    const fetch = answer(200, { ok: true });

    await deleteSubsonicUser("u/1");

    expect(fetch).toHaveBeenCalledWith("/api/subsonic-users/u%2F1", {
      method: "DELETE",
      credentials: "same-origin",
      headers: WRITE_HEADERS,
      body: "{}",
    });
  });

  it("passes on the API's refusal codes", async () => {
    answer(409, { error: "last_admin" });

    const error = await deleteSubsonicUser("u-1").then(
      () => null,
      (error: unknown) => error,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect([(error as ApiError).status, (error as ApiError).code]).toEqual([409, "last_admin"]);
  });
});

describe("describeError for the Subsonic users page", () => {
  it("has words for every code the page meets", () => {
    for (const code of [
      // The Subsonic users API's own (#82).
      "invalid_username",
      "username_taken",
      "invalid_password",
      "last_admin",
      "admin_required",
      // Every write route's guards, and a user gone since the list was read.
      "unauthenticated",
      "forbidden",
      "forbidden_origin",
      "payload_too_large",
      "invalid_request",
      "not_found",
      "internal",
      "network",
    ]) {
      expect(describeError(new ApiError(409, code, "")).title, code).not.toBe(
        "Something went wrong",
      );
    }
  });

  it("says what to do about the last Subsonic admin", () => {
    expect(describeError(new ApiError(409, "last_admin", ""))).toEqual({
      title: "This is the last Subsonic admin",
      description:
        "Library scans and the playlist import need one. Make another user a Subsonic admin first.",
    });
    expect(describeError(new ApiError(409, "admin_required", "")).description).toMatch(
      /Turn on Subsonic admin\.$/,
    );
  });
});

describe("the page's field errors", () => {
  it("puts the name and password refusals beside their fields", () => {
    expect(fieldErrorsFrom(new ApiError(409, "username_taken", ""), USER_FIELDS_BY_CODE)).toEqual({
      username: "The username is taken.",
    });
    expect(fieldErrorsFrom(new ApiError(400, "invalid_username", ""), USER_FIELDS_BY_CODE)).toEqual(
      { username: "The username is not valid." },
    );
    expect(fieldErrorsFrom(new ApiError(400, "invalid_password", ""), USER_FIELDS_BY_CODE)).toEqual(
      { password: "The password is not valid." },
    );
  });

  it("leaves the admin refusals to a toast", () => {
    for (const code of ["last_admin", "admin_required", "not_found", "forbidden"]) {
      expect(fieldErrorsFrom(new ApiError(409, code, ""), USER_FIELDS_BY_CODE)).toBeUndefined();
    }
  });
});

describe("the Subsonic admin switch", () => {
  it("is locked on while there is no Subsonic admin", () => {
    expect(adminRequired([])).toBe(true);
    expect(adminRequired([user()])).toBe(true);
    expect(adminRequired([user(), user({ id: "u-2", isAdmin: true })])).toBe(false);
  });

  it("says what a Subsonic admin may do, in the owner's words", () => {
    expect(ADMIN_HELP).toBe(
      "Can start library scans and see and manage every user's playlists in Subsonic clients.",
    );
  });
});

describe("userChanges", () => {
  it("sends only what the edit dialog changed", () => {
    const alice = user();
    expect(userChanges(alice, { username: "alice", isAdmin: false })).toBeNull();
    // The server trims a name: spaces around it are no change.
    expect(userChanges(alice, { username: " alice ", isAdmin: false })).toBeNull();
    expect(userChanges(alice, { username: " bob ", isAdmin: false })).toEqual({ username: "bob" });
    expect(userChanges(alice, { username: "Alice", isAdmin: false })).toEqual({
      username: "Alice",
    });
    expect(userChanges(alice, { username: "alice", isAdmin: true })).toEqual({ isAdmin: true });
    expect(userChanges(alice, { username: "bob", isAdmin: true })).toEqual({
      username: "bob",
      isAdmin: true,
    });
  });
});

describe("deleteConsequences", () => {
  const annotations = "Their stars, ratings, play counts, bookmarks and play queue are deleted";
  // Bucket playlists belong to the first Subsonic admin at import time.
  const imported =
    "That count includes any playlists the scan imported from the bucket while they were the first Subsonic admin.";

  it("says the owner's sentence, with the number of playlists", () => {
    expect(deleteConsequences(3)).toBe(
      `${annotations}, and their 3 playlists are deleted too, including the playlist files in the bucket. ${imported}`,
    );
    expect(deleteConsequences(1)).toBe(
      `${annotations}, and their 1 playlist is deleted too, including its playlist file in the bucket. ${imported}`,
    );
    expect(deleteConsequences(0)).toBe(`${annotations}. They have no playlists.`);
  });
});

describe("the table's dates", () => {
  // The last access is a relative time, as the Overview's (lib/format.ts).
  it("shows the day a user was created", () => {
    expect(formatDay("2026-09-30T23:30:00.000Z", "en-US", "UTC")).toBe("Sep 30, 2026");
  });
});

describe("the Libraries field (#84)", () => {
  it("shows only where more than one library exists", () => {
    expect(showsLibraries([])).toBe(false);
    expect(showsLibraries(LIBRARIES.slice(0, 1))).toBe(false);
    expect(showsLibraries(LIBRARIES)).toBe(true);
  });

  it("starts a new user from the libraries marked for new users", () => {
    const known = [
      { id: 1, defaultNewUsers: true },
      { id: 2, defaultNewUsers: false },
      { id: 3, defaultNewUsers: true },
      // Being removed: not assignable, whatever its default.
      { id: 4, defaultNewUsers: true },
    ];
    expect(defaultLibraryIds(LIBRARIES, known)).toEqual([1, 3]);
    // Without the Libraries page's list, the defaults are not known here.
    expect(defaultLibraryIds(LIBRARIES, undefined)).toEqual([]);
  });

  it("needs at least one library for a user who is not a Subsonic admin", () => {
    expect(librariesError(false, [])).toBe(LIBRARIES_REQUIRED);
    expect(LIBRARIES_REQUIRED).toBe("Choose at least one library.");
    expect(librariesError(false, [2])).toBeNull();
    // An admin sees every library: nothing to choose.
    expect(librariesError(true, [])).toBeNull();
    expect(ADMIN_LIBRARIES).toBe("Admins see every library.");
  });

  it("sends a list only for a non-admin whose libraries change", () => {
    const listener = user({ libraryIds: [1] });
    expect(
      userChanges(listener, { username: "alice", isAdmin: false, libraryIds: [1] }),
    ).toBeNull();
    expect(
      userChanges(listener, { username: "alice", isAdmin: false, libraryIds: [3, 2, 3] }),
    ).toEqual({ libraryIds: [2, 3] });
    // Without the field (one library), nothing about libraries goes.
    expect(userChanges(listener, { username: "alice", isAdmin: false })).toBeNull();
    // Promoted: an admin has every library, and the server refuses a list.
    expect(userChanges(listener, { username: "alice", isAdmin: true, libraryIds: [2] })).toEqual({
      isAdmin: true,
    });
    // Demoted with every box still checked: they keep their rows.
    const admin = user({ isAdmin: true, libraryIds: [1, 2, 3] });
    expect(
      userChanges(admin, { username: "alice", isAdmin: false, libraryIds: [1, 2, 3] }),
    ).toEqual({ isAdmin: false });
    expect(userChanges(admin, { username: "alice", isAdmin: false, libraryIds: [2] })).toEqual({
      isAdmin: false,
      libraryIds: [2],
    });
  });

  it("says in the table which libraries a user sees", () => {
    expect(librariesLabel(user({ isAdmin: true, libraryIds: [1, 2, 3] }), LIBRARIES)).toBe("All");
    expect(librariesLabel(user({ libraryIds: [2] }), LIBRARIES)).toBe("Archive");
    expect(librariesLabel(user({ libraryIds: [2, 1] }), LIBRARIES)).toBe("Music Library, Archive");
    expect(librariesLabel(user({ libraryIds: [1, 2, 3] }), LIBRARIES)).toBe("3 libraries");
    expect(librariesLabel(user({ libraryIds: [] }), LIBRARIES)).toBe("—");
  });

  it("shows a refused list beside the field", () => {
    for (const code of ["libraries_required", "invalid_library"]) {
      expect(fieldErrorsFrom(new ApiError(400, code, ""), USER_FIELDS_BY_CODE)).toEqual({
        libraries: `${describeError(new ApiError(400, code, "")).title}.`,
      });
    }
    // An admin's list is the dialog's mistake, not a field's: a toast.
    expect(
      fieldErrorsFrom(new ApiError(400, "admin_has_all_libraries", ""), USER_FIELDS_BY_CODE),
    ).toBeUndefined();
  });
});

describe("afterUserWrite", () => {
  it("reads the users again, and marks the Overview's library stale", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(subsonicUsersQuery.queryKey, { users: [user()], libraries: [] });
    queryClient.setQueryData(["overview", "library"], { playlists: [] });
    queryClient.setQueryData(["overview", "live"], { scan: null });

    await afterUserWrite(queryClient);

    expect(queryClient.getQueryState(subsonicUsersQuery.queryKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["overview", "library"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["overview", "live"])?.isInvalidated).toBe(false);
  });
});

describe("userNamesMatch", () => {
  it("is the server's comparison: equal but for ASCII case", () => {
    expect(userNamesMatch("alice", "Alice")).toBe(true);
    expect(userNamesMatch("ALICE", "alice")).toBe(true);
    expect(userNamesMatch("alice", "alicia")).toBe(false);
    // Only ASCII folds, as the server's rule does.
    expect(userNamesMatch("émile", "Émile")).toBe(false);
  });
});

describe("userWriteOptions", () => {
  /**
   * A write through a MutationObserver, as useMutation makes one, that
   * answers when the test says, with the notices it raised and the per-call
   * callbacks that ran.
   */
  function harness(fieldShown?: (error: unknown) => boolean) {
    const queryClient = new QueryClient();
    const notices: unknown[][] = [];
    const perCall: string[] = [];
    let answer: { resolve(value: string): void; reject(error: unknown): void } | undefined;
    const options = userWriteOptions<string, string>(
      queryClient,
      {
        success: (title, description) => notices.push(["success", title, description]),
        error: (error) => notices.push(["error", (error as ApiError).code]),
      },
      {
        mutationFn: () =>
          new Promise<string>((resolve, reject) => {
            answer = { resolve, reject };
          }),
        succeeded: (data, name) => ({ title: "Saved", description: `${name}: ${data}` }),
        fieldShown,
      },
    );
    const observer = new MutationObserver(queryClient, options);
    // A mounted component: useMutation subscribes to its observer.
    const unsubscribe = observer.subscribe(() => {});
    const done = observer
      .mutate("alice", {
        onSuccess: () => perCall.push("success"),
        onError: () => perCall.push("error"),
      })
      .catch(() => undefined);
    const started = new Promise((resolve) => setTimeout(resolve, 0));
    return { queryClient, notices, perCall, unsubscribe, done, started, answer: () => answer };
  }

  it("raises the outcome's toast though the dialog closed mid-write", async () => {
    const write = harness();
    await write.started;
    // The dialog closes, and its useMutation unsubscribes, before the answer.
    write.unsubscribe();
    write.answer()?.resolve("ok");
    await write.done;

    expect(write.notices).toEqual([["success", "Saved", "alice: ok"]]);
    // TanStack Query skips the per-call callbacks of an unmounted observer.
    expect(write.perCall).toEqual([]);
  });

  it("raises a refusal's toast though the dialog closed mid-write", async () => {
    const write = harness(() => false);
    await write.started;
    write.unsubscribe();
    write.answer()?.reject(new ApiError(409, "last_admin", ""));
    await write.done;

    expect(write.notices).toEqual([["error", "last_admin"]]);
    expect(write.perCall).toEqual([]);
  });

  it("leaves a field's refusal to the dialog while it shows it", async () => {
    const write = harness((error) => (error as ApiError).code === "username_taken");
    await write.started;
    write.answer()?.reject(new ApiError(409, "username_taken", ""));
    await write.done;

    expect(write.notices).toEqual([]);
    expect(write.perCall).toEqual(["error"]);
  });

  it("keeps no password in the mutation cache once nothing shows the write", async () => {
    const write = harness();
    expect(write.queryClient.getMutationCache().getAll()[0]?.options.gcTime).toBe(0);
    await write.started;
    write.answer()?.resolve("ok");
    await write.done;
  });

  it("reads the users again however the write ends", async () => {
    const write = harness();
    write.queryClient.setQueryData(subsonicUsersQuery.queryKey, { users: [], libraries: [] });
    await write.started;
    write.unsubscribe();
    write.answer()?.reject(new ApiError(500, "internal", ""));
    await write.done;

    expect(write.queryClient.getQueryState(subsonicUsersQuery.queryKey)?.isInvalidated).toBe(true);
  });

  describe("with the list on screen, re-read slowly", () => {
    /**
     * The users page's list query, active, so the write's re-read waits for
     * it; its answer comes when the test says.
     */
    function slowList(queryClient: QueryClient) {
      let answer: (() => void) | undefined;
      let reads = 0;
      const observer = new QueryObserver(queryClient, {
        queryKey: subsonicUsersQuery.queryKey,
        queryFn: () =>
          new Promise<SubsonicUserList>((resolve) => {
            reads += 1;
            answer = () => resolve({ users: [], libraries: [] });
          }),
        staleTime: Number.POSITIVE_INFINITY,
      });
      const unsubscribe = observer.subscribe(() => {});
      return { unsubscribe, reads: () => reads, answer: () => answer?.() };
    }

    async function tick() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it("toasts a field's refusal once if the dialog closes during the re-read", async () => {
      let mounted = true;
      const write = harness((error) => mounted && (error as ApiError).code === "username_taken");
      const list = slowList(write.queryClient);
      await write.started;
      list.answer();
      await tick();

      // The refusal arrives while the dialog is open; the dialog closes while
      // the list is read again, before the per-call callbacks would show it.
      write.answer()?.reject(new ApiError(409, "username_taken", ""));
      await tick();
      expect(list.reads()).toBe(2);
      mounted = false;
      write.unsubscribe();
      list.answer();
      await write.done;

      expect(write.notices).toEqual([["error", "username_taken"]]);
      expect(write.perCall).toEqual([]);
      list.unsubscribe();
    });

    it("leaves a field's refusal to a dialog still open after the re-read", async () => {
      const write = harness((error) => (error as ApiError).code === "username_taken");
      const list = slowList(write.queryClient);
      await write.started;
      list.answer();
      await tick();

      write.answer()?.reject(new ApiError(409, "username_taken", ""));
      await tick();
      list.answer();
      await write.done;

      expect(write.notices).toEqual([]);
      expect(write.perCall).toEqual(["error"]);
      list.unsubscribe();
    });
  });
});
