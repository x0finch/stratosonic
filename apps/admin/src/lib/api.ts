import { queryOptions } from "@tanstack/react-query";

/**
 * The console's calls to the Worker's JSON API under `/api` (#81, #89, #90).
 *
 * Every call is a plain `fetch` on the console's own origin: the session lives
 * in HttpOnly cookies the browser sends by itself, and a POST carries JSON,
 * which is what the API and Better Auth's origin check expect.
 */

/**
 * Who is signed in, as `GET /api/me` answers: a console user, the console's
 * own kind of account (#99), with their role and the permissions it grants.
 */
export interface Me {
  id: string;
  username: string;
  role: string;
  permissions: string[];
}

/** What `GET /api/setup` says: whether the setup token can set the server up now. */
export type SetupState = "needs-setup" | "closed";

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

/**
 * Every write carries a JSON body, `{}` when it has nothing to say (a
 * `DELETE`, say): the API's same-origin check asks for a JSON `Content-Type`
 * on every write (#82).
 */
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const write = method !== "GET";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: write
        ? { Accept: "application/json", "Content-Type": "application/json" }
        : { Accept: "application/json" },
      body: write ? JSON.stringify(body ?? {}) : undefined,
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

/** The signed-in console user, or `null` without a session. */
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

/** Creates the owner account with the setup token, while there is no console user. */
export async function setUp(request: SetupRequest): Promise<void> {
  await call("POST", "/api/setup", request);
}

/** Changes the signed-in console user's password, signing out its other sessions. */
export async function changePassword(request: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await call("POST", "/api/account/password", request);
}

/**
 * A Subsonic user as `GET /api/subsonic-users` lists it (#82): never a
 * password, in plaintext or ciphertext. `isAdmin` is the **Subsonic admin**
 * role, which has nothing to do with console roles.
 */
export interface SubsonicUser {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
  updatedAt: string;
  lastAccessAt: string | null;
}

export async function fetchSubsonicUsers(): Promise<SubsonicUser[]> {
  const { users } = await call<{ users: SubsonicUser[] }>("GET", "/api/subsonic-users");
  return users;
}

export async function createSubsonicUser(request: {
  username: string;
  password: string;
  isAdmin: boolean;
}): Promise<SubsonicUser> {
  const { user } = await call<{ user: SubsonicUser }>("POST", "/api/subsonic-users", request);
  return user;
}

/** Renames a Subsonic user, turns **Subsonic admin** on or off, or both. */
export async function updateSubsonicUser(
  id: string,
  changes: { username?: string; isAdmin?: boolean },
): Promise<SubsonicUser> {
  const { user } = await call<{ user: SubsonicUser }>(
    "PATCH",
    `/api/subsonic-users/${encodeURIComponent(id)}`,
    changes,
  );
  return user;
}

/** Sets a Subsonic user's password; no current password is needed (#82). */
export async function setSubsonicPassword(id: string, password: string): Promise<void> {
  await call("PUT", `/api/subsonic-users/${encodeURIComponent(id)}/password`, { password });
}

export async function deleteSubsonicUser(id: string): Promise<void> {
  await call("DELETE", `/api/subsonic-users/${encodeURIComponent(id)}`);
}

/**
 * The Subsonic users. Never polled: only the console changes them, and each
 * of its writes invalidates this query (#82's polling table).
 */
export const subsonicUsersQuery = queryOptions({
  queryKey: ["subsonic-users"],
  queryFn: fetchSubsonicUsers,
  staleTime: 30 * 1000,
});

/**
 * The signed-in console user. The server vouches for a session from its 5-minute
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
