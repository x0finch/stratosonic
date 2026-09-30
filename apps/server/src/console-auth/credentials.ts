import { consoleAccount, consoleSession, consoleUser, newRandomId } from "@stratosonic/db";
import { and, eq, getTableColumns, ne, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "../db";
import { hashConsolePassword } from "./password-hash";
import type { Role } from "./permissions";

/**
 * The only code that writes a console user or a console user's password (#99).
 *
 * Console users are the console's own accounts. One is a `user` row, with its
 * role, and the credential account Better Auth signs it in against, an
 * `account` row holding the password's peppered HMAC
 * (console-auth/password-hash.ts). Both writers here write in one D1 batch,
 * which D1 runs as a single transaction.
 *
 * Console users are separate from Subsonic users: nothing here reads or writes
 * the `subsonic_user` table, and no Subsonic password is ever written by the
 * console's sign-in, setup, recovery or password change. Better Auth's own
 * writers of users and passwords (sign-up, change-password, reset-password,
 * update-user) are disabled (console-auth/auth.ts), so these are the only
 * ones. This module imports nothing from Better Auth, so the first-run
 * bootstrap can read through it without loading the console's auth stack.
 */

/**
 * The shortest and longest password the console accepts. Navidrome sets no
 * rule beyond a password being there; the upper bound only keeps a request
 * from making the server hash, or compare, an arbitrarily large string, and
 * at 1,024 characters one HMAC still costs about a tenth of a millisecond
 * (scripts/bench-console-auth.ts). Better Auth
 * enforces both on sign-in (console-auth/auth.ts); the routes that set a
 * password check them before calling a writer here.
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
 * The name a new console user gets from what was typed, or `null` if there is
 * none.
 *
 * Navidrome requires only that a name is there (its `createAdmin` takes any
 * string, and its UI marks the field required), so nothing narrower is
 * imposed. Whitespace around the name is dropped, since a name that ends in a
 * space would look the same as one that does not and never be typed right
 * again, and the result must be 1 to `MAX_USERNAME_LENGTH` characters.
 */
export function acceptableUserName(typed: string): string | null {
  const userName = typed.trim();
  return userName.length >= 1 && userName.length <= MAX_USERNAME_LENGTH ? userName : null;
}

/**
 * A console user's username folded the way SQLite's `lower()` folds it, ASCII
 * letters only: the key `user.username` is generated with, and so the one the
 * username plugin must look a sign-in up by (console-auth/auth.ts). The
 * plugin's default, `toLowerCase()`, folds more, and would look some names up
 * under a key the column never holds.
 */
export function foldConsoleUsername(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Better Auth's provider id for an account signed in to with a password. */
export const CREDENTIAL_PROVIDER = "credential";

export interface NewConsoleUser {
  /** The name as entered: `acceptableUserName` has already trimmed it. */
  readonly username: string;
  readonly password: string;
  /**
   * What the console user may do (console-auth/permissions.ts). The database
   * takes at most one `owner`.
   */
  readonly role: Role;
}

/** A statement a caller adds to a writer's batch. */
export type CredentialStatement = BatchItem<"sqlite">;

export interface CreateConsoleUserOptions {
  /**
   * Create the console user only while there is none at all: the first one,
   * the owner, made by the setup token. The condition is part of the insert,
   * which D1 runs inside the batch's transaction, so two setups racing make
   * one console user between them whatever names they ask for, and the loser
   * writes nothing. Subsonic users do not count.
   */
  readonly onlyIfFirstUser?: boolean;
  /**
   * Statements to run in the same batch, after the console user and its
   * credential. They are handed the new id, so they can be made conditional
   * on the row having been written, which is how setup marks its token spent.
   * One that fails rolls the whole batch back, console user included.
   */
  readonly alongside?: (consoleUserId: string) => readonly CredentialStatement[];
}

/**
 * Creates a console user together with the credential account it signs in
 * against, and answers the new id — or `null` when nothing was written: the
 * name is already taken in any ASCII case, the role is `owner` and an owner
 * exists, or, with `onlyIfFirstUser`, a console user already exists.
 *
 * The `user` row is inserted from a `SELECT ... WHERE <condition>`, with
 * `ON CONFLICT DO NOTHING`, and the credential is inserted from the row
 * carrying the new id, so when the console user is not inserted the
 * credential finds no row to insert from and nothing is written at all.
 */
export async function createConsoleUser(
  db: Database,
  passphrase: string,
  values: NewConsoleUser,
  options: CreateConsoleUserOptions = {},
): Promise<string | null> {
  const id = newRandomId();
  const now = new Date();
  const hash = await hashConsolePassword(passphrase, values.password);
  const condition = options.onlyIfFirstUser
    ? sql`not exists (select 1 from ${consoleUser})`
    : sql`true`;

  const row: Required<NewConsoleUserRow> = {
    id,
    name: values.username,
    displayUsername: values.username,
    emailVerified: false,
    image: null,
    role: values.role,
    createdAt: now,
    updatedAt: now,
  };

  const [inserted] = await db.batch([
    db.insert(consoleUser).select(selectRow(row, condition)).onConflictDoNothing(),
    db.insert(consoleAccount).select(
      db
        .select({
          id: sql<string>`${newRandomId()}`.as("id"),
          // Better Auth finds a credential account by `account_id = user_id`.
          accountId: consoleUser.id,
          providerId: sql<string>`${CREDENTIAL_PROVIDER}`.as("provider_id"),
          userId: consoleUser.id,
          accessToken: sql<null>`null`.as("access_token"),
          refreshToken: sql<null>`null`.as("refresh_token"),
          idToken: sql<null>`null`.as("id_token"),
          accessTokenExpiresAt: sql<null>`null`.as("access_token_expires_at"),
          refreshTokenExpiresAt: sql<null>`null`.as("refresh_token_expires_at"),
          scope: sql<null>`null`.as("scope"),
          password: sql<string>`${hash}`.as("password"),
          createdAt: consoleUser.createdAt,
          updatedAt: consoleUser.updatedAt,
        })
        .from(consoleUser)
        .where(eq(consoleUser.id, id)),
    ),
    ...(options.alongside?.(id) ?? []),
  ]);

  return inserted.meta.changes > 0 ? id : null;
}

/**
 * A `user` row as an insert names it: every column but the generated
 * `username` and `email`, which Drizzle leaves out of every insert.
 */
type NewConsoleUserRow = typeof consoleUser.$inferInsert;

/**
 * `SELECT <row> WHERE <condition>`, which the insert takes its values from.
 * It has one value per column the insert names, in the same order, since both
 * are the table's columns in their declared order less the generated ones.
 * Each value is encoded by its column, as `values()` would do.
 */
function selectRow(row: Required<NewConsoleUserRow>, condition: SQL): SQL {
  const values = Object.entries(getTableColumns(consoleUser))
    .filter(([, column]) => column.generated === undefined)
    .map(([key, column]) => sql.param(row[key as keyof NewConsoleUserRow], column));

  return sql`select ${sql.join(values, sql`, `)} where ${condition}`;
}

export interface SetConsolePasswordOptions {
  /**
   * The one session to keep: whoever changes their own password stays
   * signed in where they did it (#81, "Change own password"). Every other
   * session of the console user is revoked.
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
 * Sets a console user's password and ends every console session of
 * theirs but `keepSessionId`, in one batch. No Subsonic password changes.
 *
 * The session rows are deleted at once, but a browser holding a cookie-cached
 * session keeps passing a cached check until the cache's `maxAge` (5
 * minutes) runs out; the console's writes check the session against D1
 * instead (`requireFreshSession`), so they stop immediately.
 *
 * Answers whether the password was written: `false` for a console user
 * that does not exist, in which case nothing was.
 */
export async function setConsolePassword(
  db: Database,
  passphrase: string,
  consoleUserId: string,
  plaintext: string,
  options: SetConsolePasswordOptions = {},
): Promise<boolean> {
  const hash = await hashConsolePassword(passphrase, plaintext);
  const theirs = eq(consoleSession.userId, consoleUserId);

  const [updated] = await db.batch([
    db
      .update(consoleAccount)
      .set({ password: hash, updatedAt: new Date() })
      .where(
        and(
          eq(consoleAccount.userId, consoleUserId),
          eq(consoleAccount.providerId, CREDENTIAL_PROVIDER),
        ),
      ),
    db
      .delete(consoleSession)
      .where(
        options.keepSessionId === undefined
          ? theirs
          : and(theirs, ne(consoleSession.id, options.keepSessionId)),
      ),
    ...(options.alongside ?? []),
  ]);

  return updated.meta.changes > 0;
}

/**
 * Reads the stored hash of a console user's password, as one statement for
 * a caller's batch (api/account.ts).
 */
export function storedPasswordQuery(db: Database, consoleUserId: string) {
  return db
    .select({ password: consoleAccount.password })
    .from(consoleAccount)
    .where(
      and(
        eq(consoleAccount.userId, consoleUserId),
        eq(consoleAccount.providerId, CREDENTIAL_PROVIDER),
      ),
    );
}
