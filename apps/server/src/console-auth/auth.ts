/**
 * SPIKE #86 - Better Auth for console sessions, against the existing `user`
 * table. Throwaway prototype: the shape of the configuration is the finding,
 * not the code.
 */

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { account, newRandomId, rateLimit, session, user, verification } from "@stratosonic/db";
import { betterAuth } from "better-auth/minimal";
import { username } from "better-auth/plugins/username";
import { drizzle } from "drizzle-orm/d1";
import { constantTimeEquals, decryptPassword, encryptPassword } from "../auth/crypto";
import type { Env } from "../env";

/** Where the console's auth routes are mounted. */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * SQLite's `lower()` folds ASCII letters only; so does `userNamesMatch`. The
 * plugin's default is `toLowerCase()`, which folds more, and would then look a
 * name up under a key the generated `username` column never holds.
 */
export function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * The Better Auth secret, derived from `PASSWORD_ENCRYPTION_KEY` with HKDF
 * under its own `info`, so the two uses of the one secret never share a key.
 */
export async function deriveAuthSecret(passphrase: string): Promise<string> {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode("stratosonic/console-session-secret/v1"),
    },
    material,
    256,
  );

  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface ConsoleAuthOptions {
  /** The D1 binding to use; tests pass a counting wrapper. */
  readonly db?: D1Database;
  readonly secret: string;
  readonly baseURL?: string;
  /** Overrides for measuring the defaults Better Auth would otherwise use. */
  readonly usePasswordHooks?: boolean;
}

/** Builds the Better Auth instance. Pure: no I/O until a request arrives. */
export function createConsoleAuth(env: Env, options: ConsoleAuthOptions) {
  const passphrase = env.PASSWORD_ENCRYPTION_KEY ?? "";
  const db = drizzle(options.db ?? env.DB);

  return betterAuth({
    appName: "Stratosonic",
    baseURL: options.baseURL ?? "https://stratosonic.test",
    basePath: AUTH_BASE_PATH,
    secret: options.secret,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user, session, account, verification, rateLimit },
    }),
    user: {
      // Better Auth's `email` is required and unique; ours is optional, so the
      // auth side reads a generated placeholder instead (schema.ts).
      fields: { email: "authEmail" },
      additionalFields: {
        // Read-only to Better Auth: it is returned with the session so the
        // console knows whom it is talking to, but nothing Better Auth serves
        // can set it. `is_admin` stays the source of truth.
        isAdmin: { type: "boolean", required: false, input: false, defaultValue: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      // Users are created by our own code (setup token, admin), never by a
      // public sign-up.
      disableSignUp: true,
      minPasswordLength: 1,
      ...(options.usePasswordHooks === false
        ? {}
        : {
            password: {
              hash: (password: string) => encryptPassword(passphrase, password),
              verify: async ({ hash, password }: { hash: string; password: string }) => {
                try {
                  return constantTimeEquals(await decryptPassword(passphrase, hash), password);
                } catch {
                  return false;
                }
              },
            },
          }),
    },
    session: {
      cookieCache: { enabled: true, strategy: "compact", maxAge: 5 * 60 },
    },
    rateLimit: {
      // Off by default unless NODE_ENV is "production", which a Worker never
      // sets, so it has to be switched on explicitly.
      enabled: true,
      storage: "database",
      // First match wins, in insertion order: only sign-in is limited, so a
      // session check never pays the limiter's D1 read and write.
      customRules: {
        "/sign-in/*": { window: 60, max: 5 },
        "/**": false,
      },
    },
    // Everything that would let Better Auth write a user or a password itself
    // is off: those writes go through console-auth/credentials.ts so the
    // Subsonic side (user.password) and the auth side (account.password) can
    // never disagree.
    disabledPaths: [
      "/sign-in/email",
      "/sign-up/email",
      "/update-user",
      "/change-password",
      "/change-email",
      "/delete-user",
      "/request-password-reset",
      "/reset-password",
      "/is-username-available",
    ],
    plugins: [
      username({
        usernameNormalization: foldAsciiCase,
        // Subsonic places no rule on names; any name `user_name` can hold must
        // be able to sign in.
        usernameValidator: () => true,
        minUsernameLength: 1,
        maxUsernameLength: 255,
        // The plugin's `displayUsername` is the name as entered: our
        // `user_name`. Its `username` is the generated, folded column.
        schema: { user: { fields: { displayUsername: "userName" } } },
      }),
    ],
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: { generateId: () => newRandomId() },
    },
  });
}

export type ConsoleAuth = ReturnType<typeof createConsoleAuth>;

/**
 * One instance per isolate, keyed by the secret it was built with so a test
 * that swaps bindings does not reuse a stale one.
 */
let cached: { key: string; auth: Promise<ConsoleAuth> } | null = null;

export function consoleAuth(env: Env, baseURL: string): Promise<ConsoleAuth> {
  const key = `${env.PASSWORD_ENCRYPTION_KEY ?? ""}|${baseURL}`;
  if (cached?.key !== key) {
    cached = {
      key,
      auth: deriveAuthSecret(env.PASSWORD_ENCRYPTION_KEY ?? "").then((secret) =>
        createConsoleAuth(env, { secret, baseURL }),
      ),
    };
  }

  return cached.auth;
}
