import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import {
  newRandomId,
  operator,
  operatorAccount,
  operatorSession,
  operatorVerification,
  rateLimit,
} from "@stratosonic/db";
import { isAPIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { username } from "better-auth/plugins/username";
import { drizzle } from "drizzle-orm/d1";
import {
  foldOperatorUsername,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "./credentials";
import { hashOperatorPassword, verifyOperatorPassword } from "./password-hash";

/**
 * The admin console's sessions: Better Auth (v1.7, `better-auth/minimal`, so
 * without Kysely), as the spike proved it (#86) and #81 specifies it, over
 * the console's own accounts (#99): `operator`, `operator_session`,
 * `operator_account` and `operator_verification`, which its `modelName`s map
 * its models to. An operator is not a Subsonic user, and nothing here reads
 * or writes the Subsonic `user` table.
 *
 * This module is the only one that imports Better Auth, and the Worker imports
 * it statically. Evaluating the auth stack adds about 38 ms to the Worker's
 * startup (`wrangler check startup` medians, scripts/bench-startup.mjs: 33 ms
 * without it, about 71 ms with it). At an isolate's startup that falls under
 * the separate 1 s startup limit, and Cloudflare starts isolates while the TLS
 * handshake is still under way, whereas inside the first `/api` request, as a
 * dynamic `import()` would put it, it would be charged to that request's 10 ms
 * of CPU. What `/rest/*`, `/share/*`, the cron and the scan driver's alarm
 * never pay is an instance: one is built on the first `/api` request for an
 * origin (`consoleAuth` below), and nothing else touches the auth tables but
 * the operators' writer (credentials.ts), the cron's prune of expired rows
 * (prune.ts), and the first-run check of whether an operator exists
 * (setup/initial-setup.ts).
 */

/** Where the Better Auth routes are mounted, on the `/api` sub-app. */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * The Better Auth routes the console uses, and all that the `/api` sub-app
 * forwards to it (api/app.ts): sign-in by username, the session check, which
 * is a GET (a POST to it serves `deferSessionRefresh` only, which is off), and
 * sign-out.
 */
export const CONSOLE_AUTH_ROUTES = [
  { method: "POST", path: "/sign-in/username" },
  { method: "GET", path: "/get-session" },
  { method: "POST", path: "/sign-out" },
] as const;

/**
 * Every other route Better Auth 1.7 serves with this configuration, core and
 * username plugin, which it is told to refuse as well. A test fails when an
 * upgrade registers a route on neither list (test/console-auth-routes.test.ts).
 *
 * The writers of users, passwords and emails matter most: operators and
 * their passwords are written by console-auth/credentials.ts alone, and
 * `email` is a generated placeholder that Drizzle leaves out of every write.
 * The rest are session management, social and email flows, a health check
 * (`/ok`) and the OAuth error page (`/error`), none of which the console, or
 * Better Auth itself, needs over HTTP.
 *
 * Better Auth matches these paths exactly, so the two with a parameter
 * (`/callback/:id`, `/reset-password/:token`) are listed for completeness and
 * closed by the mount, which forwards `CONSOLE_AUTH_ROUTES` alone.
 */
export const DISABLED_AUTH_PATHS = [
  // Users, passwords and emails.
  "/sign-up/email",
  "/sign-in/email",
  "/update-user",
  "/change-password",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/:token",
  "/verify-password",
  "/verify-email",
  "/send-verification-email",
  "/is-username-available",
  // Sessions, beyond the console's own sign-in and sign-out.
  "/update-session",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  // Social providers and linked accounts, of which there are none.
  "/sign-in/social",
  "/callback/:id",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/account-info",
  "/refresh-token",
  "/get-access-token",
  // The health check and the OAuth error page.
  "/ok",
  "/error",
] as const;

/**
 * The Better Auth models' names, each the name of the console's own table
 * (#99), so that no model can be mistaken for the Subsonic `user` table. The
 * rate limiter's table keeps Better Auth's name, `rate_limit`.
 */
export const OPERATOR_MODEL_NAMES = {
  user: "operator",
  session: "operator_session",
  account: "operator_account",
  verification: "operator_verification",
} as const;

/**
 * The HKDF `info` the session secret is derived under. Rotating every
 * console session, and nothing else, means bumping it to `/v2`.
 */
const SESSION_SECRET_INFO = "stratosonic/console-session-secret/v1";

/** How long a session check may trust the signed cookie instead of D1. */
const COOKIE_CACHE_SECONDS = 5 * 60;

/**
 * The Better Auth secret, which signs the session cookies: HKDF-SHA256 over
 * `PASSWORD_ENCRYPTION_KEY`, under an `info` of its own so that it never
 * equals the AES key derived from the same passphrase (auth/crypto.ts). One
 * secret fewer for a self-hoster to set, and no weaker: whoever holds the
 * passphrase can already decrypt every password.
 *
 * It is passed to Better Auth explicitly. Left unset, Better Auth would read
 * `BETTER_AUTH_SECRET` from `process.env`, or fall back to a built-in default
 * string; an empty passphrase would be just as well known, so it is refused.
 */
export async function deriveSessionSecret(passphrase: string): Promise<string> {
  if (passphrase === "") {
    throw new Error("refusing to derive the console session secret from an empty passphrase");
  }

  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode(SESSION_SECRET_INFO),
    },
    material,
    256,
  );

  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface ConsoleAuthOptions {
  /** The D1 database the sessions and credentials live in. */
  readonly db: D1Database;
  /** `PASSWORD_ENCRYPTION_KEY`: the source of the session secret and the password pepper. */
  readonly passphrase: string;
  /**
   * The origin the console is served from, e.g. `https://<name>.workers.dev`.
   * It is Better Auth's `baseURL` and its only trusted origin, and its scheme
   * decides the cookies: `https` gets `__Secure-` cookies marked `Secure`, and
   * a plain-http `wrangler dev` gets neither.
   */
  readonly origin: string;
}

function build({ db, passphrase, origin }: ConsoleAuthOptions, secret: string) {
  return betterAuth({
    appName: "Stratosonic",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    trustedOrigins: [origin],
    secret,
    database: drizzleAdapter(drizzle(db), {
      provider: "sqlite",
      // Keyed by each model's `modelName` below, which is what the adapter
      // looks a table up by.
      schema: {
        [OPERATOR_MODEL_NAMES.user]: operator,
        [OPERATOR_MODEL_NAMES.session]: operatorSession,
        [OPERATOR_MODEL_NAMES.account]: operatorAccount,
        [OPERATOR_MODEL_NAMES.verification]: operatorVerification,
        rateLimit,
      },
    }),
    user: { modelName: OPERATOR_MODEL_NAMES.user },
    account: { modelName: OPERATOR_MODEL_NAMES.account },
    verification: { modelName: OPERATOR_MODEL_NAMES.verification },
    emailAndPassword: {
      enabled: true,
      // Operators are created by our own code (the setup token)
      // through console-auth/credentials.ts, never by a public sign-up.
      disableSignUp: true,
      // The routes that set a password accept up to MAX_PASSWORD_LENGTH,
      // past Better Auth's default maximum of 128.
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      // Better Auth's default hasher is scrypt, about 100 ms of CPU a call
      // against the Free plan's 10 ms. The credential account carries a
      // peppered HMAC-SHA256 instead (ADR-0007), which hashes or verifies in
      // about a tenth of a millisecond, and compares in constant time.
      //
      // Sign-in can still tell, by timing, a name that exists from one that
      // does not: an unknown name costs one D1 read and a hash (the username
      // plugin's `hash` of the attempt, meant to even the paths out), a known
      // one with a wrong password two reads and a verification. That is an
      // accepted trade-off, not an oversight: the answers are identical, the
      // rate limit caps a caller at 5 guesses a minute, and a server with a
      // single owner has few names to find. Padding the unknown path with a
      // dummy query would cost D1 on every failed sign-in.
      password: {
        hash: (password) => hashOperatorPassword(passphrase, password),
        verify: ({ hash, password }) => verifyOperatorPassword(passphrase, hash, password),
      },
    },
    session: {
      modelName: OPERATOR_MODEL_NAMES.session,
      // A session check trusts the signed cookie for 5 minutes and touches D1
      // zero times; after that it reads the session and operator again. The
      // console's writes never trust it (`requireFreshSession`).
      cookieCache: { enabled: true, strategy: "compact", maxAge: COOKIE_CACHE_SECONDS },
    },
    rateLimit: {
      // Better Auth enables it only when NODE_ENV is "production", which a
      // Worker never sets. Memory storage would be per isolate, which limits
      // next to nothing, so the counters live in D1.
      enabled: true,
      storage: "database",
      // The first matching rule wins, in this order: only sign-in is limited,
      // so a session check never pays the limiter's D1 read and write.
      customRules: {
        "/sign-in/*": { window: 60, max: 5 },
        "/**": false,
      },
    },
    disabledPaths: [...DISABLED_AUTH_PATHS],
    plugins: [
      username({
        // SQLite's `lower()` folds ASCII letters only, and the generated
        // `username` column is `lower(display_username)`; the plugin's
        // default, `toLowerCase()`, folds more and would look some names up
        // under a key the column never holds.
        usernameNormalization: foldOperatorUsername,
        // Navidrome requires only that a name is there, and setup takes any
        // name of 1 to MAX_USERNAME_LENGTH characters (credentials.ts), so
        // every name it takes must be able to sign in, not only the plugin's
        // default 3-30 characters of `[a-zA-Z0-9_.]`.
        usernameValidator: () => true,
        minUsernameLength: 1,
        maxUsernameLength: MAX_USERNAME_LENGTH,
      }),
    ],
    advanced: {
      // The default, `x-forwarded-for`, is absent on Workers, and without an
      // address every client would share one rate-limit bucket.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Ids look like the user ids Navidrome mints.
      database: { generateId: () => newRandomId() },
    },
  });
}

export type ConsoleAuth = ReturnType<typeof build>;

/**
 * Whether Better Auth refused a session check as unauthorized. `getSession`
 * throws this, rather than answering null, when the session it is extending
 * is deleted under it: a sign-out or a password change racing the check
 * (api/routes/session, "session update fails").
 */
export function isUnauthorizedError(error: unknown): error is { headers?: unknown } {
  return isAPIError(error) && error.status === "UNAUTHORIZED";
}

/** Builds a Better Auth instance. It does no I/O until it serves a request. */
export async function createConsoleAuth(options: ConsoleAuthOptions): Promise<ConsoleAuth> {
  return build(options, await deriveSessionSecret(options.passphrase));
}

/**
 * The instances this isolate has built, by origin.
 *
 * Building one costs a millisecond of CPU and its first request a couple more
 * (#86), so each is built once per isolate rather than per request. They are
 * keyed by origin because the origin is their base URL. An isolate serves the
 * one hostname Cloudflare routes to it, or the few a deployment has
 * (`workers.dev`, a custom domain, a preview), but nothing stops a request
 * naming another, so the map is bounded: past `MAX_CACHED_INSTANCES` the
 * oldest instance is dropped, and rebuilt if its origin comes back. The
 * bindings a first request brings are the isolate's own and stay valid for its
 * life, and the passphrase is a secret that changes only with a new
 * deployment, which starts new isolates.
 *
 * What is kept is the built instance, never a pending promise, so no request
 * waits on work that belongs to another; two cold requests racing may both
 * build, and one of the instances is dropped.
 */
const instances = new Map<string, ConsoleAuth>();

/** How many origins' instances an isolate keeps at once. */
export const MAX_CACHED_INSTANCES = 8;

/** The isolate's instance for this origin, built on first use. */
export async function consoleAuth(options: ConsoleAuthOptions): Promise<ConsoleAuth> {
  const cached = instances.get(options.origin);
  if (cached) {
    return cached;
  }

  const built = await createConsoleAuth(options);
  instances.set(options.origin, built);
  // A Map iterates in insertion order, so the first key is the oldest.
  for (const origin of instances.keys()) {
    if (instances.size <= MAX_CACHED_INSTANCES) {
      break;
    }
    instances.delete(origin);
  }

  return built;
}
