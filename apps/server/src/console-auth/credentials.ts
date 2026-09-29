import { account, type NewUser, newRandomId, session, user } from "@stratosonic/db";
import { and, eq, getTableColumns, ne, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { encryptPassword } from "../auth/crypto";
import type { Database } from "../db";

/**
 * The only code that writes a password (#81, "One credential writer").
 *
 * A password lives in two places. The Subsonic API reads `user.password`,
 * because token auth needs the plaintext back (ADR-0003); the console's Better
 * Auth reads `account.password`, the credential account it signs in against,
 * and hands only that value to its verify hook. Both hold the same AES-GCM
 * ciphertext: each writer here sets `user.password` and then copies it into
 * the account, in one D1 batch, which D1 runs as a single transaction, so the
 * two can never disagree.
 *
 * Better Auth's own password writers (sign-up, change-password,
 * reset-password, update-user) are disabled for the same reason
 * (console-auth/auth.ts): they would write `account.password` alone. This
 * module imports nothing from Better Auth, so the first-run bootstrap can use
 * it without loading the console's auth stack.
 */

/**
 * The shortest and longest password the console accepts. Navidrome sets no
 * rule beyond a password being there, and Subsonic none at all; the upper
 * bound only keeps a request from making the server encrypt, or compare, an
 * arbitrarily large string; at 1,024 characters the AES-GCM work is still
 * far under a tenth of a millisecond. Better Auth enforces both on sign-in (console-auth/
 * auth.ts); the routes that set a password check them before calling a
 * writer here.
 */
export const MIN_PASSWORD_LENGTH = 1;
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * The longest name the console accepts, which is also the longest its
 * username plugin lets sign in (console-auth/auth.ts).
 */
export const MAX_USERNAME_LENGTH = 255;

/** Whether a password is one the routes that set a password accept. */
export function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

/**
 * The name a new user gets from what was typed, or `null` if there is none.
 *
 * Navidrome requires only that a name is there (its `createAdmin` takes any
 * string, and its UI marks the field required), and the console's sign-in
 * accepts any name `user_name` holds, so nothing narrower is imposed.
 * Whitespace around the name is dropped, since a name that ends in a space
 * would look the same as one that does not and never be typed right again,
 * and the result must be 1 to `MAX_USERNAME_LENGTH` characters.
 */
export function acceptableUserName(typed: string): string | null {
  const userName = typed.trim();
  return userName.length >= 1 && userName.length <= MAX_USERNAME_LENGTH ? userName : null;
}

/** Better Auth's provider id for an account signed in to with a password. */
const CREDENTIAL_PROVIDER = "credential";

export interface NewUserWithPassword {
  readonly userName: string;
  readonly password: string;
  readonly isAdmin: boolean;
  /** The Subsonic `email`; empty when the user has none, as in Navidrome. */
  readonly email?: string;
}

/** A statement a caller adds to a writer's batch. */
export type CredentialStatement = BatchItem<"sqlite">;

export interface CreateUserOptions {
  /**
   * Create the user only while there is no user at all: the first admin, made
   * by the setup token or by the first-run bootstrap. The condition is part of
   * the insert, which D1 runs inside the batch's transaction, so two of these
   * racing (two setups, or a setup and the bootstrap) make one user between
   * them whatever names they ask for, and the loser writes nothing.
   */
  readonly onlyIfFirstUser?: boolean;
  /**
   * Statements to run in the same batch, after the user and the account. They
   * are handed the new id, so they can be made conditional on the user row
   * having been written, which is how setup marks its token spent. One that
   * fails rolls the whole batch back, user included.
   */
  readonly alongside?: (userId: string) => readonly CredentialStatement[];
}

/**
 * Creates a user together with the credential account the console signs in
 * against, and answers the new user's id — or `null` when nothing was
 * written: the name is already taken in any case or, with `onlyIfFirstUser`,
 * a user already exists.
 *
 * The user row is inserted from a `SELECT ... WHERE <condition>`, with
 * `ON CONFLICT DO NOTHING`, and the account is copied from the row carrying
 * the new id, so when the user is not inserted — because another isolate
 * racing through the first-run bootstrap got there first, say — the account
 * finds no row to copy and nothing is written at all.
 */
export async function createUserWithPassword(
  db: Database,
  passphrase: string,
  values: NewUserWithPassword,
  options: CreateUserOptions = {},
): Promise<string | null> {
  const id = newRandomId();
  const now = new Date();
  const ciphertext = await encryptPassword(passphrase, values.password);

  const row: Required<NewUser> = {
    id,
    userName: values.userName,
    name: values.userName,
    email: values.email ?? "",
    password: ciphertext,
    isAdmin: values.isAdmin,
    tokenEpoch: 0,
    lastLoginAt: null,
    lastAccessAt: null,
    createdAt: now,
    updatedAt: now,
    emailVerified: false,
    image: null,
  };
  const condition = options.onlyIfFirstUser ? sql`not exists (select 1 from ${user})` : sql`true`;

  const [inserted] = await db.batch([
    db.insert(user).select(selectUserRow(row, condition)).onConflictDoNothing(),
    copyPasswordToAccount(db, id),
    ...(options.alongside?.(id) ?? []),
  ]);

  return inserted.meta.changes > 0 ? id : null;
}

/**
 * `SELECT <row> WHERE <condition>`, which a user insert takes its values
 * from. It has one value per column the insert names, in the same order,
 * since both are the table's columns in their declared order less the
 * generated ones, which Drizzle leaves out of every insert. Each value is
 * encoded by its column, as `values()` would do.
 */
function selectUserRow(row: Required<NewUser>, condition: SQL): SQL {
  const values = Object.entries(getTableColumns(user))
    .filter(([, column]) => column.generated === undefined)
    .map(([key, column]) => sql.param(row[key as keyof NewUser], column));

  return sql`select ${sql.join(values, sql`, `)} where ${condition}`;
}

export interface SetPasswordOptions {
  /**
   * The one session to keep: a user changing their own password stays signed
   * in where they did it (#81, "Change own password"). Every other session of
   * theirs is revoked.
   */
  readonly keepSessionId?: string;
  /**
   * Statements to run in the same batch, after the password is written and
   * the sessions are revoked. One that fails rolls the whole batch back:
   * recovery marks its setup token spent with a plain insert, so a token that
   * a racing request has already spent leaves the password as it was.
   */
  readonly alongside?: readonly CredentialStatement[];
}

/**
 * Sets a user's password, on both sides, and ends every console session of
 * theirs but `keepSessionId`, all in one batch.
 *
 * `token_epoch` is bumped, the per-user counter that schema.ts describes for
 * a password change. The session rows are deleted at once, but a browser
 * holding a cookie-cached session keeps passing a cached check until the
 * cache's `maxAge` (5 minutes) runs out; the console's writes check the session
 * against D1 instead (`requireFreshSession`), so they stop immediately.
 */
export async function setPassword(
  db: Database,
  passphrase: string,
  userId: string,
  plaintext: string,
  options: SetPasswordOptions = {},
): Promise<void> {
  const ciphertext = await encryptPassword(passphrase, plaintext);
  const theirs = eq(session.userId, userId);

  await db.batch([
    db
      .update(user)
      .set({ password: ciphertext, tokenEpoch: sql`${user.tokenEpoch} + 1`, updatedAt: new Date() })
      .where(eq(user.id, userId)),
    copyPasswordToAccount(db, userId),
    db
      .delete(session)
      .where(
        options.keepSessionId === undefined
          ? theirs
          : and(theirs, ne(session.id, options.keepSessionId)),
      ),
    ...(options.alongside ?? []),
  ]);
}

/**
 * Copies a user's stored password into their credential account, creating
 * the account if there is none — as for a user written before migration 0008
 * existed, which its backfill could not see. It must run after the statement
 * that wrote `user.password`, in the same batch: the value is read back from
 * the user row, so the account always carries exactly what was stored there.
 *
 * `INSERT ... SELECT` names every column in the table's order, which Drizzle
 * checks when the query is built.
 */
function copyPasswordToAccount(db: Database, userId: string) {
  return db
    .insert(account)
    .select(
      db
        .select({
          id: sql<string>`${newRandomId()}`.as("id"),
          // Better Auth finds a credential account by `account_id = user_id`.
          accountId: user.id,
          providerId: sql<string>`${CREDENTIAL_PROVIDER}`.as("provider_id"),
          userId: user.id,
          accessToken: sql<null>`null`.as("access_token"),
          refreshToken: sql<null>`null`.as("refresh_token"),
          idToken: sql<null>`null`.as("id_token"),
          accessTokenExpiresAt: sql<null>`null`.as("access_token_expires_at"),
          refreshTokenExpiresAt: sql<null>`null`.as("refresh_token_expires_at"),
          scope: sql<null>`null`.as("scope"),
          password: user.password,
          // Both writers have just set `updated_at`, so it is when the account
          // came to be if it is new.
          createdAt: user.updatedAt,
          updatedAt: user.updatedAt,
        })
        .from(user)
        .where(eq(user.id, userId)),
    )
    .onConflictDoUpdate({
      target: [account.providerId, account.accountId],
      set: { password: sql`excluded.password`, updatedAt: sql`excluded.updated_at` },
    });
}
