import { consoleUser, newRandomId, property, subsonicUser } from "@stratosonic/db";
import { sql } from "drizzle-orm";
import { encryptPassword } from "../auth/crypto";
import { OWNER_ROLE } from "../console-auth/permissions";
import { type Database, database } from "../db";
import type { Env } from "../env";
import { countUsers } from "../users/repository";
import { configuredSetupToken } from "./setup-token";

/**
 * First-run bootstrap: the server creates its one Subsonic admin user from the
 * environment, so a fresh deployment can be logged into without a setup UI
 * (ADR-0004).
 *
 * It follows Navidrome's `initialSetup` (server/initial_setup.go): a flag row
 * in the `property` table records that setup has run, and the user is only
 * created while the table is empty, so a password changed later is never
 * overwritten.
 *
 * Deprecated: `INITIAL_USER` and `INITIAL_PASSWORD` keep a password in the
 * Worker's secrets. They keep working for this release, beside the console's
 * Subsonic users page, which creates Subsonic users too (#82).
 *
 * The same first run also says, in the log, how to create the console's owner
 * when there is none and nothing can create one (#97, #99). Console users are
 * the console's own accounts, not Subsonic users, and the setup token creates
 * the owner (setup/setup-token.ts); the bootstrap never does.
 */

/** Navidrome's `consts.InitialSetupFlagKey`. */
const INITIAL_SETUP_FLAG = "InitialSetup";

/**
 * Whether a bootstrap attempt has already run to completion in this isolate.
 *
 * Setup is a question about a database that can only change from "unset" to
 * "set", so asking once per isolate is enough — and it keeps D1 out of the path
 * of every request, which the free tier's write budget cares about.
 *
 * What is remembered is only this marker, never the promise that produced it:
 * a shared promise would leave every later request awaiting I/O that belongs to
 * the first request's context, which can be cancelled out from under them. Each
 * request that finds the marker unset does the work itself, with its own
 * bindings, and `onConflictDoNothing` keeps a few of them racing harmless.
 */
let attempted = false;

/** Whether this isolate has already reported that no owner exists nor can be created. */
let reportedNoOwner = false;

/** Whether this isolate has already reported that no Subsonic user exists nor will be created. */
let reportedNoSubsonicUser = false;

/**
 * Runs the bootstrap at most once per isolate. Called from both Worker entry
 * points — the first request an isolate serves, and a scheduled run — because
 * either may be the first thing that ever touches a new deployment.
 *
 * It never rejects: a server that cannot bootstrap should still answer, with
 * the authentication failures that follow from having no users, rather than
 * fail the request with something the client cannot act on. A failed attempt
 * leaves the marker unset, so the next request retries it.
 */
export async function ensureInitialSetup(env: Env): Promise<void> {
  if (attempted) {
    return;
  }

  try {
    await runInitialSetup(env);
    // An environment that does not say what to create is not a failure: there
    // is nothing to retry until the deployment itself changes, and retrying per
    // request would put a D1 read in front of every one of them.
    attempted = true;
  } catch (error) {
    console.error("initial setup failed; it will be retried on the next request", error);
  }
}

/**
 * The bootstrap itself, guarded by the flag rather than by the isolate-level
 * cache, so running it twice — in another isolate, or after a restart — is a
 * no-op.
 */
export async function runInitialSetup(env: Env): Promise<void> {
  const db = database(env);

  const { done, hasOwner } = await readFirstRun(db, shouldCheckForOwner(env));
  if (hasOwner === false) {
    reportedNoOwner = true;
    console.log(
      "no owner exists: set SETUP_TOKEN (wrangler secret put SETUP_TOKEN) to create one in the console",
    );
  }

  if (done) {
    return;
  }

  if ((await countUsers(db)) > 0) {
    await markInitialSetupDone(db);
    return;
  }

  const created = await createInitialAdmin(env, db);
  if (!created) {
    // Without the configuration there is nothing to create, and the flag stays
    // unset on purpose: setting the missing secrets and restarting should still
    // produce the admin user. (Navidrome sets its flag either way, but it can
    // also create users through its own UI, which Stratosonic has not got.)
    return;
  }

  await markInitialSetupDone(db);
}

/**
 * Whether the first run should ask if the console has an owner: only while
 * that has not been reported in this isolate, and only when there is no
 * usable `SETUP_TOKEN`, since with one the console's `/setup` already offers
 * to create the owner.
 */
function shouldCheckForOwner(env: Env): boolean {
  return !reportedNoOwner && configuredSetupToken(env) === null;
}

/**
 * Whether the flag is set and, when asked, whether the console has an owner
 * (`null` when not asked), in one statement: the question about the owner
 * costs a row read from the index that allows only one, never a round trip of
 * its own.
 */
async function readFirstRun(
  db: Database,
  checkForOwner: boolean,
): Promise<{ done: boolean; hasOwner: boolean | null }> {
  const row = await db.get<{ done: number; has_owner: number | null }>(sql`select
    exists (select 1 from ${property} where ${property.id} = ${INITIAL_SETUP_FLAG}) as done,
    ${checkForOwner ? sql`exists (select 1 from ${consoleUser} where ${consoleUser.role} = ${OWNER_ROLE})` : sql`null`} as has_owner`);

  return {
    done: row?.done === 1,
    hasOwner: row?.has_owner == null ? null : row.has_owner === 1,
  };
}

async function markInitialSetupDone(db: Database): Promise<void> {
  await db
    .insert(property)
    .values({ id: INITIAL_SETUP_FLAG, value: new Date().toISOString() })
    .onConflictDoNothing();
}

/**
 * Creates the admin user, or reports that the environment does not say what to
 * create. `onConflictDoNothing` keeps two isolates racing through their first
 * request from turning into two rows.
 */
async function createInitialAdmin(env: Env, db: Database): Promise<boolean> {
  const { INITIAL_USER: userName, INITIAL_PASSWORD: password } = env;

  // Without the password the deprecated bootstrap is not in use:
  // `INITIAL_USER` is a plain var in wrangler.jsonc, so it being set says
  // nothing. This is only reached while there is no Subsonic user, so how
  // to create one, in the console or with the deprecated pair, is worth a
  // line, once per isolate.
  if (!password) {
    if (!reportedNoSubsonicUser) {
      reportedNoSubsonicUser = true;
      console.log(
        "no Subsonic user exists: create one in the console (Subsonic users), or set INITIAL_USER and INITIAL_PASSWORD (deprecated)",
      );
    }
    return false;
  }

  // The password is set, so the bootstrap is meant to be used: what else it
  // needs is a misconfiguration worth a warning that says what to fix.
  if (!userName || !env.PASSWORD_ENCRYPTION_KEY) {
    const missing = [
      userName ? null : "INITIAL_USER",
      env.PASSWORD_ENCRYPTION_KEY ? null : "PASSWORD_ENCRYPTION_KEY",
    ].filter((name) => name !== null);
    console.warn(
      `no initial Subsonic user created: INITIAL_PASSWORD is set but ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not`,
    );
    return false;
  }

  const now = new Date();
  await db
    .insert(subsonicUser)
    .values({
      id: newRandomId(),
      userName,
      name: userName,
      password: await encryptPassword(env.PASSWORD_ENCRYPTION_KEY, password),
      isAdmin: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  return true;
}
