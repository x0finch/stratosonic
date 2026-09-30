import { queryOptions } from "@tanstack/react-query";

/**
 * The console's calls to the Worker's JSON API under `/api` (#81, #89, #90).
 *
 * Every call is a plain `fetch` on the console's own origin: the session lives
 * in HttpOnly cookies the browser sends by itself, and a POST carries JSON,
 * which is what the API and Better Auth's origin check expect.
 */

/**
 * Who is signed in, as `GET /api/me` answers: an operator, the console's own
 * kind of account (#99), which has no role.
 */
export interface Me {
  id: string;
  username: string;
}

/** What `GET /api/setup` says the setup token may do now. */
export type SetupState = "needs-setup" | "reset-available" | "closed";

/**
 * A refused or failed call. `code` is the API's `error`, Better Auth's `code`
 * brought to the same vocabulary, `rate_limited` for a 429, `network` when
 * the Worker could not be reached, or `http_<status>` when the body names
 * nothing.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The seconds a rate-limited caller has to wait, when the server says. */
  readonly retryAfter: number | undefined;

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message || code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/**
 * Better Auth answers with its own upper-case codes. The two the console meets
 * on sign-in are renamed to the API's words; any other is lower-cased.
 */
const BETTER_AUTH_CODES: Record<string, string> = {
  INVALID_USERNAME_OR_PASSWORD: "invalid_credentials",
  INVALID_ORIGIN: "forbidden_origin",
  MISSING_OR_NULL_ORIGIN: "forbidden_origin",
};

function errorCode(status: number, body: unknown): string {
  if (status === 429) {
    return "rate_limited";
  }
  if (typeof body === "object" && body !== null) {
    if ("error" in body && typeof body.error === "string") {
      return body.error;
    }
    if ("code" in body && typeof body.code === "string") {
      return BETTER_AUTH_CODES[body.code] ?? body.code.toLowerCase();
    }
  }
  return `http_${status}`;
}

function errorMessage(body: unknown): string {
  if (typeof body === "object" && body !== null && "message" in body) {
    return typeof body.message === "string" ? body.message : "";
  }
  return "";
}

/** Better Auth's rate limiter names the wait in `X-Retry-After`, in seconds. */
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("X-Retry-After") ?? response.headers.get("Retry-After");
  const seconds = value === null ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers:
        method === "POST"
          ? { Accept: "application/json", "Content-Type": "application/json" }
          : { Accept: "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch (error) {
    throw new ApiError(0, "network", error instanceof Error ? error.message : "");
  }

  const payload = await readBody(response);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      errorCode(response.status, payload),
      errorMessage(payload),
      retryAfter(response),
    );
  }
  return payload as T;
}

/** The signed-in operator, or `null` without a session. */
export async function fetchMe(): Promise<Me | null> {
  try {
    return await call<Me>("GET", "/api/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function fetchSetupState(): Promise<SetupState> {
  const { state } = await call<{ state: SetupState }>("GET", "/api/setup");
  return state;
}

export interface Credentials {
  username: string;
  password: string;
}

/** Signs in through Better Auth's username plugin; the session is a cookie. */
export async function signIn({ username, password }: Credentials): Promise<void> {
  await call("POST", "/api/auth/sign-in/username", { username, password });
}

export async function signOut(): Promise<void> {
  await call("POST", "/api/auth/sign-out");
}

export interface SetupRequest extends Credentials {
  token: string;
}

/** Creates the first operator account with the setup token, while there is none. */
export async function setUp(request: SetupRequest): Promise<void> {
  await call("POST", "/api/setup", request);
}

/** Sets an operator's password with an unspent setup token, signing it out everywhere. */
export async function resetOperatorPassword(request: SetupRequest): Promise<void> {
  await call("POST", "/api/setup/reset", request);
}

/** Changes the signed-in operator's password, signing out its other sessions. */
export async function changePassword(request: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await call("POST", "/api/account/password", request);
}

/**
 * The signed-in operator. The server vouches for a session from its 5-minute
 * cookie cache (#81), so a fresher copy here would buy nothing.
 */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: fetchMe,
  staleTime: 5 * 60 * 1000,
  retry: false,
});

/**
 * What the setup token may do. It changes only when a setup screen spends
 * the token, which drops this query (setup-form.tsx), or when the Worker's
 * secret is replaced, so a refocused window need not ask again at once.
 */
export const setupStateQuery = queryOptions({
  queryKey: ["setup-state"],
  queryFn: fetchSetupState,
  staleTime: 30 * 1000,
  retry: false,
});
