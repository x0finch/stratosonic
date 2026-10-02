import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type Me, meQuery } from "@/lib/api";
import { leaveSignedOut, signOutWhenUnauthenticated } from "@/lib/sign-out";

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
