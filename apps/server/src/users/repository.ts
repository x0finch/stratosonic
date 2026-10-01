import {
  type NewSubsonicUser,
  newRandomId,
  playlist,
  type SubsonicUser,
  subsonicUser,
} from "@stratosonic/db";
import { and, asc, eq, getTableColumns, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db";

/**
 * Reads and writes of the `subsonic_user` table. Everything that touches
 * Subsonic users goes through here, so the case-insensitive lookup and the
 * column names live in one place.
 */

/**
 * Finds a user by name, ignoring case — Navidrome matches `user_name` with
 * `COLLATE NOCASE` (persistence/user_repository.go). The comparison is written
 * the same way as the table's unique index so the index can serve it.
 */
export async function findUserByUsername(
  db: Database,
  userName: string,
): Promise<SubsonicUser | null> {
  const rows = await db
    .select()
    .from(subsonicUser)
    .where(sql`lower(${subsonicUser.userName}) = lower(${userName})`)
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The administrator an imported playlist belongs to: the longest-standing
 * one, which on this server is the account the first run bootstrapped.
 *
 * Navidrome picks the owner of an auto-imported playlist the same way, with
 * `FindFirstAdmin` - `Sort: "updated_at", Max: 1` over the admins
 * (persistence/user_repository.go), read by the playlist phase of its scanner
 * (scanner/phase_4_playlists.go). The id breaks a tie so two admins written
 * in the same millisecond still give one answer.
 */
export async function findFirstAdmin(db: Database): Promise<SubsonicUser | null> {
  const rows = await db
    .select()
    .from(subsonicUser)
    .where(eq(subsonicUser.isAdmin, true))
    .orderBy(asc(subsonicUser.updatedAt), asc(subsonicUser.id))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Whether two usernames name the same account, by the same rule the lookup
 * uses. SQLite's `lower()` folds ASCII letters and nothing else, so this folds
 * ASCII only too: `toLowerCase()` would also fold characters the query leaves
 * alone, and the two rules would then disagree about who a name refers to.
 */
export function userNamesMatch(left: string, right: string): boolean {
  return foldAsciiCase(left) === foldAsciiCase(right);
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Inserts a user. Fails if the name is taken, whatever its case. */
export async function insertUser(db: Database, values: NewSubsonicUser): Promise<void> {
  await db.insert(subsonicUser).values(values);
}

/** Counts every user, which is how the first-run bootstrap knows it is first. */
export async function countUsers(db: Database): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)` }).from(subsonicUser);

  return rows[0]?.count ?? 0;
}

export async function updateLastAccessAt(db: Database, id: string, at: Date): Promise<void> {
  await db.update(subsonicUser).set({ lastAccessAt: at }).where(eq(subsonicUser.id, id));
}

/* ----------------------------------------------- the console's writes -- */

/*
 * The writes the console makes to Subsonic users (#82, "API: Subsonic
 * users"), after Navidrome's persistence/user_repository.go: `Put` stamps
 * `updated_at` on every write, and `validateUsernameUnique` refuses a name
 * another user has in any case. Here the unique index on `lower(user_name)`
 * decides that, so two creates racing for one name cannot both pass.
 *
 * The rule that the last Subsonic admin can be neither demoted nor deleted is
 * Stratosonic's own (Navidrome's `Update` and `Delete` do not enforce it):
 * the playlist import needs an admin (`importPlaylists` skips without one),
 * and so do `startScan`, `getScanStatus` and `getUsers`. It is a condition of
 * the write itself, which D1 runs as one statement, atomically, so two
 * demotions racing cannot both pass.
 */

/**
 * What the console is told about a Subsonic user: never the password, in
 * plaintext or ciphertext, nor anything derived from it.
 */
const userViewColumns = {
  id: subsonicUser.id,
  userName: subsonicUser.userName,
  isAdmin: subsonicUser.isAdmin,
  createdAt: subsonicUser.createdAt,
  updatedAt: subsonicUser.updatedAt,
  lastAccessAt: subsonicUser.lastAccessAt,
};

/**
 * How many playlists the user owns, counted in the statement that reads the
 * user: a subquery correlated to the row, which `playlist_owner_id_idx`
 * answers by reading the owner's index entries (and one past the last), not
 * the playlists. The console's delete dialog names it, since a delete takes
 * the user's playlists with it (#82, open question 1).
 *
 * Both columns are named with their table, by hand: in a statement on one
 * table Drizzle writes a column bare, and a bare `"id"` inside the subquery
 * would be the playlist's own id, counting nothing.
 */
const playlistCount = sql<number>`(select count(*) from ${playlist}
  where ${playlist}.${sql.identifier(playlist.ownerId.name)}
    = ${subsonicUser}.${sql.identifier(subsonicUser.id.name)})`
  .mapWith(Number)
  .as("playlist_count");

/** `userViewColumns` with the user's playlist count. */
const userViewWithCount = { ...userViewColumns, playlistCount };

/** A user as `userViewWithCount` reads it. */
export interface UserViewRow {
  readonly id: string;
  readonly userName: string;
  readonly isAdmin: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastAccessAt: Date | null;
  readonly playlistCount: number;
}

/**
 * Every user, by name ignoring case and then id: the unique index's key, so
 * the list reads in the same terms a lookup matches in. One statement, the
 * playlist counts included.
 */
export function listUsers(db: Database): Promise<UserViewRow[]> {
  return db
    .select(userViewWithCount)
    .from(subsonicUser)
    .orderBy(sql`lower(${subsonicUser.userName})`, asc(subsonicUser.id));
}

export interface UserCreate {
  /** Already accepted by `acceptableUserName` (users/validation.ts). */
  readonly userName: string;
  /** The ciphertext `encryptPassword` made of the password (ADR-0003). */
  readonly password: string;
  readonly isAdmin: boolean;
}

/**
 * Creates a user as the `INITIAL_*` bootstrap does (setup/initial-setup.ts):
 * a random id (Navidrome's `id.NewRandom`), `name` equal to `user_name`, and
 * `created_at` equal to `updated_at`. Answers the new user, or
 * `"admin_required"` when it is not an admin and no admin exists: the first
 * Subsonic user must be one, as the bootstrap and Navidrome's `createAdmin`
 * make it, so there is an admin from the first user on.
 *
 * That condition is part of the insert, `INSERT ... SELECT ... WHERE`, so it
 * costs no round trip of its own and no other create can slip past it. A
 * name taken in any case throws, from the unique index
 * (`isUserNameConflict`).
 */
export async function createUser(
  db: Database,
  values: UserCreate,
  now: Date = new Date(),
): Promise<UserViewRow | "admin_required"> {
  const row: Required<NewSubsonicUser> = {
    id: newRandomId(),
    userName: values.userName,
    name: values.userName,
    email: "",
    password: values.password,
    isAdmin: values.isAdmin,
    tokenEpoch: 0,
    lastLoginAt: null,
    lastAccessAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const condition = values.isAdmin
    ? sql`1`
    : sql`exists (select 1 from ${subsonicUser} where ${subsonicUser.isAdmin} = 1)`;

  const [created] = await db
    .insert(subsonicUser)
    .select(selectUserRow(row, condition))
    .returning(userViewColumns);

  // A new id owns no playlist yet: there is nothing to count.
  return created ? { ...created, playlistCount: 0 } : "admin_required";
}

/**
 * `SELECT <row> WHERE <condition>`, which the insert takes its values from:
 * one value per column, in the table's declared order, which is the order
 * the insert names them in, each encoded by its column as `values()` would
 * (console-auth/credentials.ts builds a console user the same way).
 */
function selectUserRow(row: Required<NewSubsonicUser>, condition: SQL): SQL {
  const values = Object.entries(getTableColumns(subsonicUser)).map(([key, column]) =>
    sql.param(row[key as keyof NewSubsonicUser], column),
  );

  return sql`select ${sql.join(values, sql`, `)} where ${condition}`;
}

/**
 * Whether a write failed because the name is taken in some case: the unique
 * index on `lower(user_name)` refused it. D1 reports the SQLite error in the
 * message, which Drizzle may wrap, so the causes are searched too, as
 * `isSpentTokenConflict` (setup/setup-token.ts) does.
 */
export function isUserNameConflict(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (
      cause.message.includes("UNIQUE constraint failed") &&
      cause.message.includes("subsonic_user_user_name_unique")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Whether the user a statement writes may stop being an admin: they are not
 * one, or some other admin exists. The other admin is looked for under an
 * alias of its own, so the outer statement's columns stay the row it writes.
 */
function mayLoseAdmin(id: string): SQL {
  return sql`(${subsonicUser.isAdmin} = 0 or exists (select 1 from ${subsonicUser} as other
    where other.is_admin = 1 and other.id <> ${id}))`;
}

export interface UserChanges {
  /** Already accepted by `acceptableUserName`. */
  readonly userName?: string;
  readonly isAdmin?: boolean;
}

/**
 * Renames a user, makes or unmakes them an admin, or both, in one guarded
 * statement, and answers the user as written, or `null` when nothing was: no
 * user has this id, or it would demote the last admin (`whyRefused` tells
 * which).
 *
 * `name` follows `user_name`, as the bootstrap sets it: there is no separate
 * display name yet. `updated_at` moves, as Navidrome's `Put` moves it, which
 * also moves the user in `findFirstAdmin`'s order, as it does there; the
 * owners of existing playlists never change. A rename onto a name another
 * user has in some case throws (`isUserNameConflict`); one that only changes
 * the case of the user's own name is the same index key, and passes.
 */
export async function updateUser(
  db: Database,
  id: string,
  changes: UserChanges,
  now: Date = new Date(),
): Promise<UserViewRow | null> {
  const [updated] = await db
    .update(subsonicUser)
    .set({
      ...(changes.userName === undefined
        ? {}
        : { userName: changes.userName, name: changes.userName }),
      ...(changes.isAdmin === undefined ? {} : { isAdmin: changes.isAdmin }),
      updatedAt: now,
    })
    .where(and(eq(subsonicUser.id, id), changes.isAdmin === false ? mayLoseAdmin(id) : undefined))
    .returning(userViewWithCount);

  return updated ?? null;
}

/**
 * Replaces a user's password with new ciphertext, and answers whether there
 * was such a user. `token_epoch` is left alone: Navidrome bumps it to revoke
 * the JWTs its own UI issues, which Stratosonic does not issue (#99), and
 * Subsonic's `p` and `t`/`s` read the stored ciphertext on every request
 * (auth/authenticate.ts), so the old password stops working at once.
 */
export async function setUserPassword(
  db: Database,
  id: string,
  ciphertext: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(subsonicUser)
    .set({ password: ciphertext, updatedAt: now })
    .where(eq(subsonicUser.id, id))
    .returning({ id: subsonicUser.id });

  return updated.length > 0;
}

/** Why a guarded write of a user wrote nothing. */
export type UserRefusal = "not_found" | "last_admin";

/**
 * Why a guarded write of this user wrote nothing, read after the fact: there
 * is no such user, or there is, and so it was the last-admin guard.
 */
export async function whyRefused(db: Database, id: string): Promise<UserRefusal> {
  const rows = await db
    .select({ id: subsonicUser.id })
    .from(subsonicUser)
    .where(eq(subsonicUser.id, id));

  return rows.length === 0 ? "not_found" : "last_admin";
}

/** What deleting a user would do, read before anything is deleted. */
export interface UserDeletionCheck {
  /** `null` when the user may be deleted. */
  readonly refusal: UserRefusal | null;
  /** The user's playlists, by the `.m3u` each one is. */
  readonly playlistKeys: readonly string[];
}

/**
 * Whether a user may be deleted, by the same guard the delete itself is
 * written with, and the files of the playlists that would go with them, in
 * one round trip. The playlists are found through `playlist_owner_id_idx`.
 */
export async function checkUserDeletion(db: Database, id: string): Promise<UserDeletionCheck> {
  const [users, playlists] = await db.batch([
    db
      .select({ mayLoseAdmin: sql<number>`${mayLoseAdmin(id)}` })
      .from(subsonicUser)
      .where(eq(subsonicUser.id, id)),
    db.select({ r2Key: playlist.r2Key }).from(playlist).where(eq(playlist.ownerId, id)),
  ]);

  const user = users[0];
  const refusal = user === undefined ? "not_found" : user.mayLoseAdmin ? null : "last_admin";

  return { refusal, playlistKeys: playlists.map((row) => row.r2Key) };
}

/**
 * Deletes a user, unless they are the last admin, and the playlist rows they
 * own, in one batch, which D1 runs as one transaction. Answers whether the
 * user was deleted; when not, nothing was.
 *
 * What goes with the user:
 *
 * - by foreign key (`on delete cascade` to `subsonic_user.id`, which D1
 *   enforces; migration 0008 pointed them at the renamed table): their
 *   `annotation` rows (stars, ratings, play counts), `now_playing`,
 *   `play_queue` and `bookmark`;
 * - their playlists, as Navidrome's `playlist_user_user_id_fk` cascades them,
 *   each with its `playlist_track` rows through that table's own cascade.
 *   `playlist.owner_id` has no foreign key, so the rows are deleted here, and
 *   only when the statement before has deleted the user. Their `.m3u` files
 *   are the caller's to delete first (users/delete.ts).
 */
export async function deleteUserRows(db: Database, id: string): Promise<boolean> {
  const [deleted] = await db.batch([
    db
      .delete(subsonicUser)
      .where(and(eq(subsonicUser.id, id), mayLoseAdmin(id)))
      .returning({ id: subsonicUser.id }),
    db
      .delete(playlist)
      .where(
        and(
          eq(playlist.ownerId, id),
          sql`not exists (select 1 from ${subsonicUser} as gone where gone.id = ${id})`,
        ),
      ),
  ]);

  return deleted.length > 0;
}
