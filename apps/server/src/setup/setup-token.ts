import { operator, property } from "@stratosonic/db";
import { eq, sql } from "drizzle-orm";
import { constantTimeEquals } from "../auth/crypto";
import type { CredentialStatement } from "../console-auth/credentials";
import type { Database } from "../db";
import type { Env } from "../env";

/**
 * The setup token (#81, "Setup and recovery"): a Worker secret,
 * `SETUP_TOKEN`, that creates the first operator in the console while there
 * is none, and resets an operator's password once there is. Operators are the
 * console's own accounts (#99); Subsonic users play no part here.
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
  /** Whether any operator exists. Subsonic users do not count. */
  readonly hasOperators: boolean;
  /** Whether the token with this digest has been used. */
  readonly spent: boolean;
  /** The operator a recovery names, matched as sign-in matches a name. */
  readonly target: { readonly id: string; readonly username: string } | null;
}

interface SetupFactsRow {
  has_operators: number;
  spent: number;
  target_id: string | null;
  target_username: string | null;
}

/**
 * Reads whether any operator exists, whether the token is spent and, for a
 * recovery, the operator it names, all in one statement. The name is folded
 * the way sign-in folds it, SQLite's ASCII-only `lower()`, and looked up by
 * the generated `username` column, whose unique index serves the lookup;
 * without a name the target is `null`.
 */
export async function readSetupFacts(
  db: Database,
  digest: string,
  username: string | null = null,
): Promise<SetupFacts> {
  const row =
    await db.get<SetupFactsRow>(sql`select exists (select 1 from ${operator}) as has_operators,
    exists (select 1 from ${property} where ${property.id} = ${spentKey(digest)}) as spent,
    target.id as target_id,
    target.display_username as target_username
  from (select 1)
  left join (
    select ${operator.id} as id, ${operator.displayUsername} as display_username
    from ${operator}
    where ${operator.username} = lower(${username})
  ) as target on true`);

  return {
    hasOperators: row?.has_operators === 1,
    spent: row?.spent === 1,
    target:
      row?.target_id != null ? { id: row.target_id, username: row.target_username ?? "" } : null,
  };
}

/**
 * The state the console shows. Setup needs a usable token that is unspent,
 * and no operator; recovery the same token and at least one operator.
 */
export function setupState(facts: SetupFacts | null): SetupState {
  if (facts === null || facts.spent) {
    return "closed";
  }

  return facts.hasOperators ? "reset-available" : "needs-setup";
}

/**
 * Records the token as spent, for a setup's or a recovery's batch, but only
 * if the operator it wrote is there when the batch runs: when another setup
 * won the race, the operator was not inserted, and when a recovery's
 * operator was deleted after its check, there is none to reset, and this
 * writes nothing either, so the token stays unspent.
 *
 * It is a plain insert, so when a racing request has spent the same value
 * first the key exists, the insert fails, and D1 rolls the whole batch back,
 * the password with it (`isSpentTokenConflict`).
 */
export function markSpentFor(
  db: Database,
  digest: string,
  operatorId: string,
): CredentialStatement {
  return db.insert(property).select(
    db
      .select({
        id: sql<string>`${spentKey(digest)}`.as("id"),
        value: sql<string>`${new Date().toISOString()}`.as("value"),
      })
      .from(operator)
      .where(eq(operator.id, operatorId)),
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
