import { property, user } from "@stratosonic/db";
import { eq, sql } from "drizzle-orm";
import { constantTimeEquals } from "../auth/crypto";
import type { CredentialStatement } from "../console-auth/credentials";
import type { Database } from "../db";
import type { Env } from "../env";

/**
 * The setup token (#81, "Setup and recovery"): a Worker secret,
 * `SETUP_TOKEN`, that creates the first admin in the console while there are
 * no users, and resets an admin's password once there are.
 *
 * Navidrome's `POST /auth/createAdmin` guards only on there being no user
 * yet (server/auth.go). A Worker is on a public `workers.dev` URL from its
 * first deploy, so whoever found it first would take the server; the token is
 * Stratosonic's addition for that.
 *
 * Each value works once. Using it records `sha256(token)` in the `property`
 * table, under a key of its own (`SetupTokenSpent:<hex digest>`), in the same
 * D1 batch as the password it set, and a value whose digest is recorded is
 * refused from then on. Recovering again means setting a new value with
 * `wrangler secret put SETUP_TOKEN`. A row per value, rather than one row
 * holding the last digest, keeps an old value spent after a newer one is
 * used, so putting the old secret back cannot reopen it.
 */

/**
 * The shortest token accepted, in characters. The README suggests
 * `openssl rand -hex 32`, which gives 64.
 */
export const MIN_SETUP_TOKEN_LENGTH = 32;

/** The `property` key a spent token's digest is recorded under, before the digest. */
export const SETUP_TOKEN_SPENT_KEY = "SetupTokenSpent";

/** What `GET /api/setup` answers, and what the console shows for it. */
export type SetupState = "needs-setup" | "reset-available" | "closed";

/** Whether this isolate has already reported a token too short to use. */
let warnedAboutShortToken = false;

/**
 * The configured token, or `null` when there is none that can be used: unset,
 * or shorter than `MIN_SETUP_TOKEN_LENGTH`, which is reported once per
 * isolate rather than trusted, since a short value can be guessed.
 */
export function configuredSetupToken(env: Env): string | null {
  const token = env.SETUP_TOKEN;
  if (!token) {
    return null;
  }

  if (token.length < MIN_SETUP_TOKEN_LENGTH) {
    if (!warnedAboutShortToken) {
      warnedAboutShortToken = true;
      console.warn(
        `setup: SETUP_TOKEN is shorter than ${MIN_SETUP_TOKEN_LENGTH} characters and is ignored`,
      );
    }
    return null;
  }

  return token;
}

/** A token's SHA-256 digest, lowercase hex: what a spent token is recorded as. */
export async function setupTokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The digest of the configured token when `given` is that token, or `null`
 * when it is not or no usable token is configured. The comparison is of the
 * two digests, in constant time, so neither how much of the token a guess got
 * right nor how long the token is shows in the timing.
 */
export async function matchSetupToken(env: Env, given: string): Promise<string | null> {
  const configured = configuredSetupToken(env);
  if (configured === null) {
    return null;
  }

  const [expected, actual] = await Promise.all([
    setupTokenDigest(configured),
    setupTokenDigest(given),
  ]);

  return constantTimeEquals(expected, actual) ? expected : null;
}

function spentKey(digest: string): string {
  return `${SETUP_TOKEN_SPENT_KEY}:${digest}`;
}

/** What setup and recovery decide on, read in one statement. */
export interface SetupFacts {
  readonly hasUsers: boolean;
  /** Whether the token with this digest has been used. */
  readonly spent: boolean;
  /** The user a recovery names, matched as Subsonic's `u` is, if there is one. */
  readonly target: {
    readonly id: string;
    readonly userName: string;
    readonly isAdmin: boolean;
  } | null;
}

interface SetupFactsRow {
  has_users: number;
  spent: number;
  target_id: string | null;
  target_user_name: string | null;
  target_is_admin: number | null;
}

/**
 * Reads whether any user exists, whether the token is spent and, for a
 * recovery, the user it names, all in one statement. The name is matched the
 * way `findUserByUsername` matches it, which the unique index on
 * `lower(user_name)` serves; without a name the target is `null`.
 */
export async function readSetupFacts(
  db: Database,
  digest: string,
  userName: string | null = null,
): Promise<SetupFacts> {
  const row = await db.get<SetupFactsRow>(sql`select exists (select 1 from ${user}) as has_users,
    exists (select 1 from ${property} where ${property.id} = ${spentKey(digest)}) as spent,
    target.id as target_id,
    target.user_name as target_user_name,
    target.is_admin as target_is_admin
  from (select 1)
  left join (
    select ${user.id} as id, ${user.userName} as user_name, ${user.isAdmin} as is_admin
    from ${user}
    where lower(${user.userName}) = lower(${userName})
  ) as target on true`);

  return {
    hasUsers: row?.has_users === 1,
    spent: row?.spent === 1,
    target:
      row?.target_id != null
        ? {
            id: row.target_id,
            userName: row.target_user_name ?? "",
            isAdmin: row.target_is_admin === 1,
          }
        : null,
  };
}

/**
 * The state the console shows. Setup needs a usable token that is unspent,
 * and no user; recovery the same token and at least one user.
 */
export function setupState(facts: SetupFacts | null): SetupState {
  if (facts === null || facts.spent) {
    return "closed";
  }

  return facts.hasUsers ? "reset-available" : "needs-setup";
}

/**
 * Records the token as spent, for a recovery's batch. It is a plain insert,
 * so when a racing request has spent the same value first the key exists, the
 * insert fails, and D1 rolls the whole batch back, the password with it
 * (`isSpentTokenConflict`).
 */
export function markSpent(db: Database, digest: string): CredentialStatement {
  return db.insert(property).values({ id: spentKey(digest), value: new Date().toISOString() });
}

/**
 * Records the token as spent for a setup's batch, but only if the user it
 * created is there: when another setup, or the first-run bootstrap, won the
 * race, the user was not inserted and this writes nothing either. It is a
 * plain insert too, for the same reason as `markSpent`.
 */
export function markSpentIfCreated(
  db: Database,
  digest: string,
  userId: string,
): CredentialStatement {
  return db.insert(property).select(
    db
      .select({
        id: sql<string>`${spentKey(digest)}`.as("id"),
        value: sql<string>`${new Date().toISOString()}`.as("value"),
      })
      .from(user)
      .where(eq(user.id, userId)),
  );
}

/**
 * Whether a batch failed because its token was spent under it: the spent
 * key's insert hit the primary key. D1 reports the SQLite error in the
 * message, which Drizzle may wrap, so the causes are searched too.
 */
export function isSpentTokenConflict(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (cause.message.includes("UNIQUE constraint failed: property.id")) {
      return true;
    }
  }

  return false;
}
