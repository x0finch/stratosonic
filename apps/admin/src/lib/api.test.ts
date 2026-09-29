import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, changePassword, fetchMe, signIn } from "@/lib/api";
import { describeError } from "@/lib/errors";

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const fetch = vi.fn(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function refusal(call: Promise<unknown>): Promise<ApiError> {
  const error = await call.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the API client", () => {
  it("posts JSON on the console's own origin", async () => {
    const fetch = answer(200, { token: "t" });

    await signIn({ username: "admin", password: "sesame" });

    expect(fetch).toHaveBeenCalledWith("/api/auth/sign-in/username", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "sesame" }),
    });
  });

  it("reads no session as nobody signed in", async () => {
    answer(401, { error: "unauthenticated" });

    expect(await fetchMe()).toBeNull();
  });

  it("passes on any other refusal of /api/me", async () => {
    answer(503, { error: "not_configured" });

    expect((await refusal(fetchMe())).code).toBe("not_configured");
  });

  it("takes the API's error code", async () => {
    answer(400, { error: "wrong_password" });

    const error = await refusal(changePassword({ currentPassword: "a", newPassword: "b" }));

    expect([error.status, error.code]).toEqual([400, "wrong_password"]);
  });

  it("brings Better Auth's codes to the API's words", async () => {
    answer(401, { code: "INVALID_USERNAME_OR_PASSWORD", message: "Invalid username or password" });
    expect((await refusal(signIn({ username: "a", password: "b" }))).code).toBe(
      "invalid_credentials",
    );

    answer(403, { code: "INVALID_ORIGIN", message: "Invalid origin" });
    expect((await refusal(signIn({ username: "a", password: "b" }))).code).toBe("forbidden_origin");

    answer(400, { code: "PASSWORD_TOO_LONG", message: "Password too long" });
    expect((await refusal(signIn({ username: "a", password: "b" }))).code).toBe(
      "password_too_long",
    );
  });

  it("reads a 429 as rate limited, with the wait Better Auth names", async () => {
    answer(
      429,
      { message: "Too many requests. Please try again later." },
      { "X-Retry-After": "42" },
    );

    const error = await refusal(signIn({ username: "a", password: "b" }));

    expect([error.code, error.retryAfter]).toEqual(["rate_limited", 42]);
    expect(describeError(error)).toEqual({
      title: "Too many attempts",
      description: "Wait 42 seconds and try again.",
    });
  });

  it("names a Worker it could not reach", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    expect((await refusal(fetchMe())).code).toBe("network");
  });

  it("names the status when the body names nothing", async () => {
    answer(502, undefined);

    expect((await refusal(fetchMe())).code).toBe("http_502");
  });
});

describe("describeError", () => {
  it("has words for every refusal the auth screens meet", () => {
    for (const code of [
      "invalid_credentials",
      "invalid_token",
      "wrong_password",
      "unauthenticated",
      "not_configured",
      "insecure_origin",
      "forbidden_origin",
      // The setup, recovery and password change API's (#90).
      "payload_too_large",
      "invalid_request",
      "invalid_username",
      "invalid_password",
      "already_set_up",
      "not_set_up",
      "unknown_user",
      "not_admin",
      // Any route's: requireAdmin's, the unknown path's, a handler that threw.
      "forbidden",
      "not_found",
      "internal",
    ]) {
      expect(describeError(new ApiError(400, code, "")).title).not.toBe("Something went wrong");
    }
  });

  it("falls back to the server's own message, then to the status", () => {
    expect(describeError(new ApiError(400, "odd", "Odd request")).description).toBe("Odd request");
    expect(describeError(new ApiError(418, "http_418", "")).description).toBe(
      "The server answered 418 (http_418). Try again.",
    );
  });
});
