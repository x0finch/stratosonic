/**
 * SPIKE #86 - the only code that writes a password. The Subsonic side reads
 * `user.password` (it needs the plaintext back for token auth, ADR-0003); the
 * console side reads `account.password` through Better Auth. Both hold the same
 * AES-GCM ciphertext, written here in one D1 batch - which D1 runs as a single
 * transaction - so the two can never disagree.
 */

import { account, newRandomId, session, user } from "@stratosonic/db";
import { and, eq, sql } from "drizzle-orm";
import { encryptPassword } from "../auth/crypto";
import type { Database } from "../db";

export interface NewCredentialUser {
  readonly userName: string;
  readonly password: string;
  readonly isAdmin: boolean;
  readonly email?: string;
}

/**
 * Creates a user together with the credential account Better Auth signs in
 * against. Public sign-up is disabled; this is how the setup-token flow and
 * an admin create accounts.
 */
export async function createUserWithCredential(
  db: Database,
  passphrase: string,
  values: NewCredentialUser,
): Promise<string> {
  const id = newRandomId();
  const now = new Date();
  const ciphertext = await encryptPassword(passphrase, values.password);

  await db.batch([
    db.insert(user).values({
      id,
      userName: values.userName,
      name: values.userName,
      email: values.email ?? "",
      password: ciphertext,
      isAdmin: values.isAdmin,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(account).values({
      id: newRandomId(),
      // Better Auth finds the credential account by `accountId = userId`.
      accountId: id,
      providerId: "credential",
      userId: id,
      password: ciphertext,
      createdAt: now,
      updatedAt: now,
    }),
  ]);

  return id;
}

/**
 * Sets a user's password and ends every console session they have, in one
 * batch. `token_epoch` is bumped as Navidrome does on a password change.
 *
 * The session rows are deleted, but a browser holding a cookie-cached session
 * keeps passing `get-session` until that cache's `maxAge` runs out, unless the
 * route that checks it asks for `disableCookieCache`.
 */
export async function setPasswordAndRevokeSessions(
  db: Database,
  passphrase: string,
  userId: string,
  password: string,
): Promise<void> {
  const now = new Date();
  const ciphertext = await encryptPassword(passphrase, password);

  await db.batch([
    db
      .update(user)
      .set({ password: ciphertext, tokenEpoch: sql`${user.tokenEpoch} + 1`, updatedAt: now })
      .where(eq(user.id, userId)),
    db
      .update(account)
      .set({ password: ciphertext, updatedAt: now })
      .where(and(eq(account.userId, userId), eq(account.providerId, "credential"))),
    db.delete(session).where(eq(session.userId, userId)),
  ]);
}
