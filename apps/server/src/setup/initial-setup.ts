import { newRandomId, property, user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { encryptPassword } from "../auth/crypto";
import { type Database, database } from "../db";
import type { Env } from "../env";
import { countUsers } from "../users/repository";

/**
 * First-run bootstrap: the server creates its one admin user from the
 * environment, so a fresh deployment can be logged into without a setup UI
 * (ADR-0004).
 *
 * It follows Navidrome's `initialSetup` (server/initial_setup.go): a flag row
 * in the `property` table records that setup has run, and the user is only
 * created while the table is empty, so a password changed later is never
 * overwritten.
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

  if (await initialSetupDone(db)) {
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

async function initialSetupDone(db: Database): Promise<boolean> {
  const rows = await db.select().from(property).where(eq(property.id, INITIAL_SETUP_FLAG)).limit(1);

  return rows.length > 0;
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

  if (!userName || !password || !env.PASSWORD_ENCRYPTION_KEY) {
    console.warn(
      "no initial user created: INITIAL_USER, INITIAL_PASSWORD and PASSWORD_ENCRYPTION_KEY must all be set",
    );
    return false;
  }

  const now = new Date();
  await db
    .insert(user)
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
