import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { account, newRandomId, rateLimit, session, user, verification } from "@stratosonic/db";
import { isAPIError } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { username } from "better-auth/plugins/username";
import { drizzle } from "drizzle-orm/d1";
import { constantTimeEquals, decryptPassword, encryptPassword } from "../auth/crypto";
import { foldAsciiCase } from "../users/repository";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./credentials";

/**
 * The admin console's sessions: Better Auth (v1.7, `better-auth/minimal`, so
 * without Kysely) over the existing `user` table, as the spike proved it
 * (#86) and #81 specifies it.
 *
 * This module is the only one that imports Better Auth, and the Worker imports
 * it statically. Evaluating the auth stack takes about 45 ms: at an isolate's
 * startup that falls under the separate 1 s startup limit, and Cloudflare
 * starts isolates while the TLS handshake is still under way, whereas inside
 * the first `/api` request, as a dynamic `import()` would put it, it would be
 * charged to that request's 10 ms of CPU. What `/rest/*`, `/share/*`, the cron
 * and the scan driver's alarm never pay is an instance: one is built on the
 * first `/api` request for an origin (`consoleAuth` below), and nothing else
 * touches the auth tables but the credential writer.
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
 * The writers of users, passwords and emails matter most: those writes go
 * through console-auth/credentials.ts, so that `user.password` and
 * `account.password` can never disagree, and `auth_email` is a generated
 * placeholder that Drizzle leaves out of every write. The rest are session
 * management, social and email flows, a health check (`/ok`) and the OAuth
 * error page (`/error`), none of which the console, or Better Auth itself,
 * needs over HTTP.
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
  /** `PASSWORD_ENCRYPTION_KEY`: the AES-GCM passphrase, and the secret's source. */
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
      schema: { user, session, account, verification, rateLimit },
    }),
    user: {
      // Better Auth's `email` is required and unique; ours is neither, so it
      // reads the generated placeholder column instead (schema.ts).
      fields: { email: "authEmail" },
      additionalFields: {
        // Read-only to Better Auth: it comes back with the session, so the
        // console knows whom it is talking to, but nothing Better Auth serves
        // can set it. `is_admin` stays the source of truth.
        isAdmin: { type: "boolean", required: false, input: false, defaultValue: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      // Users are created by our own code (the first-run bootstrap, the setup
      // token) through console-auth/credentials.ts, never by a public sign-up.
      disableSignUp: true,
      // Better Auth's default maximum, 128, would lock a longer Subsonic
      // password out of the console.
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      // Better Auth's default hasher is scrypt, about 100 ms of CPU a call
      // against the Free plan's 10 ms, and a hash the Subsonic API could not
      // read. The credential account carries the same AES-GCM ciphertext as
      // `user.password` instead (ADR-0003), so verifying is a decryption and
      // a constant-time comparison.
      password: {
        hash: (password) => encryptPassword(passphrase, password),
        verify: async ({ hash, password }) => {
          try {
            return constantTimeEquals(await decryptPassword(passphrase, hash), password);
          } catch {
            // Not a ciphertext this passphrase wrote: a failed sign-in.
            return false;
          }
        },
      },
    },
    session: {
      // A session check trusts the signed cookie for 5 minutes and touches D1
      // zero times; after that it reads the session and user again. The
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
        // `username` column is `lower(user_name)`; the plugin's default,
        // `toLowerCase()`, folds more and would look some names up under a
        // key the column never holds. This is the fold the Subsonic `u`
        // lookup uses, so both sides agree on whom a name refers to.
        usernameNormalization: foldAsciiCase,
        // Subsonic places no rule on names (Navidrome requires only that there
        // is one), so any name `user_name` holds must be able to sign in, not
        // only the plugin's default 3-30 characters of `[a-zA-Z0-9_.]`.
        usernameValidator: () => true,
        minUsernameLength: 1,
        maxUsernameLength: 255,
        // The plugin's `displayUsername` is the name as entered, our
        // `user_name`; its `username` is the generated, folded column.
        schema: { user: { fields: { displayUsername: "userName" } } },
      }),
    ],
    advanced: {
      // The default, `x-forwarded-for`, is absent on Workers, and without an
      // address every client would share one rate-limit bucket.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Session and account ids look like the user ids Navidrome mints.
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
 * keyed by origin because the origin is their base URL; an isolate serves the
 * one hostname Cloudflare routes to it, or at most the few a deployment has
 * (`workers.dev` and a custom domain), so the map stays that small. The
 * bindings a first request brings are the isolate's own and stay valid for its
 * life, and the passphrase is a secret that changes only with a new
 * deployment, which starts new isolates.
 *
 * What is kept is the built instance, never a pending promise, so no request
 * waits on work that belongs to another; two cold requests racing may both
 * build, and one of the instances is dropped.
 */
const instances = new Map<string, ConsoleAuth>();

/** The isolate's instance for this origin, built on first use. */
export async function consoleAuth(options: ConsoleAuthOptions): Promise<ConsoleAuth> {
  const cached = instances.get(options.origin);
  if (cached) {
    return cached;
  }

  const built = await createConsoleAuth(options);
  instances.set(options.origin, built);

  return built;
}
