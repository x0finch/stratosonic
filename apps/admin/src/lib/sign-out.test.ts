import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type Me, meQuery } from "@/lib/api";
import { leaveSignedOut, signOutWhenUnauthenticated, whenSignedOut } from "@/lib/sign-out";
import { UploadQueue } from "@/lib/uploads";

describe("leaving the console after signing out", () => {
  it("goes to plain /login, with no page to return to", async () => {
    const navigate = vi.fn(async () => {});

    await leaveSignedOut(new QueryClient(), { navigate });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ to: "/login" });
  });

  it("forgets what the user read, and is signed out before it navigates", async () => {
    const queryClient = new QueryClient();
    const me: Me = { id: "1", username: "owner", role: "owner", permissions: [] };
    queryClient.setQueryData(meQuery.queryKey, me);
    queryClient.setQueryData(["users"], [{ id: "1" }]);
    let meWhenNavigating: unknown;
    const navigate = vi.fn(async () => {
      meWhenNavigating = queryClient.getQueryData(meQuery.queryKey);
    });

    await leaveSignedOut(queryClient, { navigate });

    expect(meWhenNavigating).toBeNull();
    expect(queryClient.getQueryData(["users"])).toBeUndefined();
  });
});

describe("a call refused for want of a session", () => {
  it("signs the console out, and nothing else does", () => {
    const queryClient = new QueryClient();
    const me: Me = { id: "1", username: "owner", role: "owner", permissions: [] };
    queryClient.setQueryData(meQuery.queryKey, me);

    expect(signOutWhenUnauthenticated(queryClient, new ApiError(403, "forbidden", ""))).toBe(false);
    expect(signOutWhenUnauthenticated(queryClient, undefined)).toBe(false);
    expect(queryClient.getQueryData(meQuery.queryKey)).toEqual(me);

    expect(signOutWhenUnauthenticated(queryClient, new ApiError(401, "unauthenticated", ""))).toBe(
      true,
    );
    expect(queryClient.getQueryData(meQuery.queryKey)).toBeNull();
  });
});

describe("what ends with the session", () => {
  it("hears of a sign-out by request, and of a session that ended, until it stops", async () => {
    const ended = vi.fn();
    const stop = whenSignedOut(ended);

    await leaveSignedOut(new QueryClient(), { navigate: async () => {} });
    expect(ended).toHaveBeenCalledTimes(1);
    signOutWhenUnauthenticated(new QueryClient(), new ApiError(401, "unauthenticated", ""));
    expect(ended).toHaveBeenCalledTimes(2);
    signOutWhenUnauthenticated(new QueryClient(), new ApiError(500, "internal", ""));
    expect(ended).toHaveBeenCalledTimes(2);

    stop();
    await leaveSignedOut(new QueryClient(), { navigate: async () => {} });
    expect(ended).toHaveBeenCalledTimes(2);
  });

  it("can end an upload queue, whose uploads are then canceled", async () => {
    const aborted: AbortSignal[] = [];
    const queue = new UploadQueue({
      sign: async (_prefix, files) => ({
        uploads: files.map((file) => ({
          key: file.key,
          url: "https://account.r2.cloudflarestorage.com/navidrome/a.flac",
          method: "PUT" as const,
          headers: {},
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        })),
        clock: { serverTime: new Date().toISOString(), receivedAt: Date.now() },
      }),
      complete: async () => ({ scan: null, clock: { serverTime: "", receivedAt: 0 } }),
      put: (_upload, _body, _progress, signal) => {
        aborted.push(signal);
        return new Promise(() => {});
      },
    });
    const stop = whenSignedOut(() => queue.dispose());
    queue.add(
      [{ file: { name: "a.flac", size: 1 } as never, prefix: "", key: "a.flac", refusal: null }],
      10,
    );
    await vi.waitFor(() => expect(aborted).toHaveLength(1));

    await leaveSignedOut(new QueryClient(), { navigate: async () => {} });

    expect(aborted[0]?.aborted).toBe(true);
    expect(queue.getSnapshot().items).toEqual([]);
    stop();
  });
});
