import {
  DEFAULT_LIBRARY_ID,
  type Library,
  library,
  type NewSubsonicUser,
  newRandomId,
  playlist,
  type SubsonicUser,
  subsonicUser,
  userLibrary,
} from "@stratosonic/db";
import { and, asc, eq, getTableColumns, inArray, notInArray, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db";

/**
 * Reads and writes of the `subsonic_user` table. Everything that touches
 * Subsonic users goes through here, so the case-insensitive lookup and the
 * column names live in one place.
 */

/** A library as the user's row carries it: what `getMusicFolders` answers. */
export interface UserLibrary {
  readonly id: number;
  readonly name: string;
}

/** A user as authentication reads them: the row, and the libraries they see. */
export interface UserWithLibraries extends SubsonicUser {
  /** The active libraries the user sees, by id. */
  readonly libraries: readonly UserLibrary[];
  /** Every library, `removing` ones included, for the fast path. */
  readonly libraryCount: number;
}

/**
 * The libraries a user sees, as a JSON array in the user's own row: the
 * active ones, every one for an admin and those `user_library` grants
 * otherwise (#84, "Who sees what"). Navidrome's `selectUserWithLibraries`
 * aggregates the user's libraries into the user row the same way
 * (persistence/user_repository.go), names included, so `getMusicFolders`
 * needs no statement of its own.
 *
 * The user's columns are named with their table, by hand, as
 * `playlistCount`'s are: Drizzle writes a column of a one-table statement
 * bare, and a bare `"id"` in here would be the library's.
 */
const userLibraries = sql<string>`(select json_group_array(json_object('id', l.id, 'name', l.name))
  from library l where l.state = 'active' and (${subsonicUser}.${sql.identifier(subsonicUser.isAdmin.name)}
    or exists (select 1 from user_library ul
      where ul.user_id = ${subsonicUser}.${sql.identifier(subsonicUser.id.name)} and ul.library_id = l.id)))`.as(
  "libraries",
);

/** Every library, `removing` ones included: Navidrome's `count(*) from library`. */
const libraryCount = sql<number>`(select count(*) from library)`
  .mapWith(Number)
  .as("library_count");

/**
 * Finds a user by name, ignoring case — Navidrome matches `user_name` with
 * `COLLATE NOCASE` (persistence/user_repository.go). The comparison is written
 * the same way as the table's unique index so the index can serve it.
 *
 * It runs on every Subsonic request, and reads the user's libraries in the
 * same statement (`userLibraries`, `libraryCount`): one row per library and
 * the user's own `user_library` rows, and no round trip of its own.
 */
export async function findUserByUsername(
  db: Database,
  userName: string,
): Promise<UserWithLibraries | null> {
  const rows = await db
    .select({ ...getTableColumns(subsonicUser), libraries: userLibraries, libraryCount })
    .from(subsonicUser)
    .where(sql`lower(${subsonicUser.userName}) = lower(${userName})`)
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  const libraries = (JSON.parse(row.libraries) as UserLibrary[]).sort((a, b) => a.id - b.id);

  return { ...row, libraries };
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

/** A user as the console's list and writes answer them: with their libraries. */
export interface UserViewWithLibraries extends UserViewRow {
  /** The active libraries the user's `user_library` rows grant, by id. */
  readonly libraryIds: readonly number[];
}

/**
 * The active libraries a user's `user_library` rows grant, as a JSON array:
 * what the console's Libraries field shows (#84, "Per-user access"). An
 * admin sees every library whatever the rows say, and is given a row for
 * each anyway, so an admin's rows are every library too.
 */
function grantedLibraryIds(userId: SQL) {
  return sql<string>`(select json_group_array(ul.library_id) from ${userLibrary} as ul
    where ul.user_id = ${userId}
      and exists (select 1 from ${library} as l where l.id = ul.library_id and l.state = 'active'))`;
}

/** `grantedLibraryIds` as a column, read and sorted. */
function libraryIdsOf(json: string): number[] {
  return (JSON.parse(json) as number[]).sort((a, b) => a - b);
}

/**
 * Every user, by name ignoring case and then id: the unique index's key, so
 * the list reads in the same terms a lookup matches in. One statement, the
 * playlist counts and the libraries included.
 */
function listUsersQuery(db: Database) {
  return db
    .select({
      ...userViewWithCount,
      libraryIds: grantedLibraryIds(
        sql`${subsonicUser}.${sql.identifier(subsonicUser.id.name)}`,
      ).as("library_ids"),
    })
    .from(subsonicUser)
    .orderBy(sql`lower(${subsonicUser.userName})`, asc(subsonicUser.id));
}

/** The active libraries, by id: what a user may be given. */
function activeLibrariesQuery(db: Database) {
  return db
    .select({ id: library.id, name: library.name })
    .from(library)
    .where(eq(library.state, "active"))
    .orderBy(asc(library.id));
}

/**
 * Every user, with their libraries, and every library a user may be given,
 * in one batch.
 */
export async function listUsers(db: Database): Promise<{
  users: UserViewWithLibraries[];
  libraries: { id: number; name: string }[];
}> {
  const [users, libraries] = await db.batch([listUsersQuery(db), activeLibrariesQuery(db)]);

  return {
    users: users.map((row) => ({ ...row, libraryIds: libraryIdsOf(row.libraryIds) })),
    libraries,
  };
}

/** Every active library's id, as a JSON array: what an admin is given. */
function activeLibraryIds() {
  return sql<string>`(select json_group_array(l.id) from ${library} as l where l.state = 'active')`;
}

export interface UserCreate {
  /** Already accepted by `acceptableUserName` (users/validation.ts). */
  readonly userName: string;
  /** The ciphertext `encryptPassword` made of the password (ADR-0003). */
  readonly password: string;
  readonly isAdmin: boolean;
  /**
   * A non-admin's libraries, at least one, distinct: given instead of the
   * defaults. An admin is given every library, and takes no list.
   */
  readonly libraryIds?: readonly number[];
}

/**
 * Which libraries a user is given: every one, the defaults for new users, or
 * these.
 */
export type LibraryGrant = "all" | "defaults" | readonly number[];

/**
 * The most libraries a user's list may name: each is a bound parameter of
 * the statements that check and write it, and D1 binds at most a hundred.
 */
export const MAX_USER_LIBRARIES = 50;

/**
 * Whether every library in `ids` (distinct) exists and is active: what a
 * list must hold to be written (#84, "Per-user access": an unknown or
 * removing id is `invalid_library`).
 */
function librariesValid(ids: readonly number[]): SQL {
  return sql`(select count(*) from ${library} as valid
    where valid.state = 'active' and valid.id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})) = ${ids.length}`;
}

/**
 * The statement that gives a user libraries, as Navidrome's user repository
 * does on `Put` (persistence/user_repository.go): an admin gets every library
 * (`INSERT OR IGNORE ... SELECT ?, id FROM library`), and a new non-admin the
 * libraries marked `default_new_users`, or the ones listed. Rows the user has
 * already are kept. Only active libraries are given: a library being removed
 * is never granted again.
 *
 * It goes in the batch after the write that creates or promotes the user, and
 * inserts only when the user exists by then, so a create that wrote nothing
 * grants nothing (and breaks no foreign key), and only when `when` holds,
 * for a write the batch's first statement may have refused. The user is
 * looked for under an alias of its own, as `mayLoseAdmin` looks for another
 * admin.
 */
export function grantLibrariesStatement(
  db: Database,
  userId: string,
  grant: LibraryGrant,
  when?: SQL,
) {
  return db
    .insert(userLibrary)
    .select(
      db
        .select({ userId: sql<string>`${userId}`.as("user_id"), libraryId: library.id })
        .from(library)
        .where(
          and(
            eq(library.state, "active"),
            grant === "defaults" ? eq(library.defaultNewUsers, true) : undefined,
            typeof grant === "object" ? inArray(library.id, [...grant]) : undefined,
            // Also the WHERE that `INSERT ... SELECT ... ON CONFLICT` needs:
            // without one SQLite parses `ON` as a join constraint. Keep it.
            sql`exists (select 1 from ${subsonicUser} as granted where granted.id = ${userId})`,
            when,
          ),
        ),
    )
    .onConflictDoNothing();
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
 *
 * The user's libraries are written in the same batch (#84, "Per-user
 * access"): every library for an admin, and for anybody else the ones the
 * request lists, or else the `default_new_users` ones. A list naming a
 * library that is unknown or being removed is part of the insert's
 * condition too, and answered `"invalid_library"`, with nothing written; a
 * second statement, run only then, tells it from `"admin_required"`.
 */
export async function createUser(
  db: Database,
  values: UserCreate,
  now: Date = new Date(),
): Promise<UserViewWithLibraries | "admin_required" | "invalid_library"> {
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
  const hasAdmin = sql`exists (select 1 from ${subsonicUser} where ${subsonicUser.isAdmin} = 1)`;
  const listed = values.isAdmin ? undefined : values.libraryIds;
  const condition = and(
    values.isAdmin ? sql`1` : hasAdmin,
    listed === undefined ? undefined : librariesValid(listed),
  ) as SQL;

  // A new user has no rows yet, so what the grant inserts is all they have.
  const [[created], granted] = await db.batch([
    db.insert(subsonicUser).select(selectUserRow(row, condition)).returning(userViewColumns),
    grantLibrariesStatement(db, row.id, values.isAdmin ? "all" : (listed ?? "defaults")).returning({
      libraryId: userLibrary.libraryId,
    }),
  ]);

  if (created === undefined) {
    if (listed === undefined) {
      return "admin_required";
    }
    // Refused with a list: by the list, unless there is no admin at all.
    const admins = await db
      .select({ id: subsonicUser.id })
      .from(subsonicUser)
      .where(eq(subsonicUser.isAdmin, true))
      .limit(1);
    return admins.length > 0 ? "invalid_library" : "admin_required";
  }

  // A new id owns no playlist yet: there is nothing to count.
  return {
    ...created,
    playlistCount: 0,
    libraryIds: granted.map((row) => row.libraryId).sort((a, b) => a - b),
  };
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
  /**
   * The user's libraries, replacing the ones they have: at least one,
   * distinct. Only for a user who is not an admin, or is being made not one
   * (an admin has every library), so never with `isAdmin: true`.
   */
  readonly libraryIds?: readonly number[];
}

/**
 * Renames a user, makes or unmakes them an admin, sets their libraries, or
 * any of these, in one guarded batch, and answers the user as written, or
 * `null` when nothing was: no user has this id, it would demote the last
 * admin, or the libraries cannot be set (`whyUpdateRefused` tells which).
 *
 * `name` follows `user_name`, as the bootstrap sets it: there is no separate
 * display name yet. `updated_at` moves, as Navidrome's `Put` moves it, which
 * also moves the user in `findFirstAdmin`'s order, as it does there; the
 * owners of existing playlists never change. A rename onto a name another
 * user has in some case throws (`isUserNameConflict`); one that only changes
 * the case of the user's own name is the same index key, and passes.
 *
 * Making a user an admin also gives them every library, in the same batch, as
 * Navidrome's `Put` does for an admin. Unmaking one keeps the rows they have,
 * as Navidrome keeps them.
 *
 * Setting a user's libraries replaces their rows in the same batch (#84,
 * "Per-user access", after Navidrome's `SetUserLibraries`): the update is
 * guarded by the user not being an admin once written, and by every library
 * listed being active, and the rows are rewritten only when the update was
 * (the user's `updated_at` is `now`). Auth reads the rows on every request,
 * so the change applies on the next `/rest` call.
 */
export async function updateUser(
  db: Database,
  id: string,
  changes: UserChanges,
  now: Date = new Date(),
): Promise<UserViewWithLibraries | null> {
  const { libraryIds } = changes;
  if (libraryIds !== undefined && changes.isAdmin === true) {
    throw new Error("an admin has every library, and takes no list");
  }

  const update = db
    .update(subsonicUser)
    .set({
      ...(changes.userName === undefined
        ? {}
        : { userName: changes.userName, name: changes.userName }),
      ...(changes.isAdmin === undefined ? {} : { isAdmin: changes.isAdmin }),
      updatedAt: now,
    })
    .where(
      and(
        eq(subsonicUser.id, id),
        changes.isAdmin === false ? mayLoseAdmin(id) : undefined,
        libraryIds !== undefined && changes.isAdmin === undefined
          ? eq(subsonicUser.isAdmin, false)
          : undefined,
        libraryIds === undefined ? undefined : librariesValid(libraryIds),
      ),
    )
    .returning({
      ...userViewWithCount,
      // What the user has once the batch has run, read in the update itself:
      // a list is what it sets (every id was found active, or nothing is
      // written), a promotion gives every active library, and anything else
      // leaves the rows as they are.
      libraryIds: (changes.isAdmin === true
        ? activeLibraryIds()
        : grantedLibraryIds(sql`${subsonicUser}.${sql.identifier(subsonicUser.id.name)}`)
      ).as("library_ids"),
    });

  if (libraryIds !== undefined) {
    // The update wrote, as far as the rows can tell: the user is stamped
    // `now`, is not an admin, and every library listed is active. The
    // stamp alone could be another write's at the same millisecond, so the
    // update's own guards are repeated, and a refused update writes no grant.
    const written = sql`exists (select 1 from ${subsonicUser} as written
      where written.id = ${id} and written.updated_at = ${now.getTime()}
      and written.is_admin = 0 and ${librariesValid(libraryIds)})`;
    const [[updated]] = await db.batch([
      update,
      db
        .delete(userLibrary)
        .where(
          and(
            eq(userLibrary.userId, id),
            notInArray(userLibrary.libraryId, [...libraryIds]),
            written,
          ),
        ),
      grantLibrariesStatement(db, id, libraryIds, written),
    ]);
    return updated === undefined ? null : { ...updated, libraryIds };
  }

  const [updated] =
    changes.isAdmin === true
      ? (await db.batch([update, grantLibrariesStatement(db, id, "all")]))[0]
      : await update;

  return updated === undefined
    ? null
    : { ...updated, libraryIds: libraryIdsOf(updated.libraryIds) };
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

/** Why a guarded update of a user wrote nothing, its libraries included. */
export type UserUpdateRefusal = UserRefusal | "admin_has_all_libraries" | "invalid_library";

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

/**
 * Why `updateUser` wrote nothing, read after the fact, as `whyRefused`
 * reads it, with the changes the update was asked for: a list of libraries
 * may also be why, when the user is an admin and stays one, or a library
 * listed is unknown or being removed.
 */
export async function whyUpdateRefused(
  db: Database,
  id: string,
  changes: UserChanges,
): Promise<UserUpdateRefusal> {
  const { libraryIds } = changes;
  const rows = await db
    .select({
      isAdmin: subsonicUser.isAdmin,
      librariesValid:
        libraryIds === undefined
          ? sql<number>`1`.mapWith(Number)
          : sql<number>`${librariesValid(libraryIds)}`.mapWith(Number),
    })
    .from(subsonicUser)
    .where(eq(subsonicUser.id, id));

  const user = rows[0];
  if (user === undefined) {
    return "not_found";
  }
  if (libraryIds !== undefined && changes.isAdmin === undefined && user.isAdmin) {
    return "admin_has_all_libraries";
  }
  if (!user.librariesValid) {
    return "invalid_library";
  }
  return "last_admin";
}

/** A library row as a user's deletion reads it: how to reach its bucket, and whether to. */
export type PlaylistFilesLibrary = Pick<
  Library,
  "id" | "kind" | "path" | "endpoint" | "bucket" | "credentials" | "writable" | "state"
>;

/** What deleting a user would do, read before anything is deleted. */
export interface UserDeletionCheck {
  /** `null` when the user may be deleted. */
  readonly refusal: UserRefusal | null;
  /** The user's playlists, by the library and the `.m3u` each one is. */
  readonly playlistFiles: readonly { readonly libraryId: number; readonly r2Key: string }[];
  /**
   * The rows of the libraries other than library 1 those files are in, by
   * id: what reaching their buckets takes (#84). Library 1 is the binding.
   */
  readonly libraries: ReadonlyMap<number, PlaylistFilesLibrary>;
}

/**
 * Whether a user may be deleted, by the same guard the delete itself is
 * written with, and the files of the playlists that would go with them, with
 * their libraries, in one round trip. The playlists are found through
 * `playlist_owner_id_idx`. When some of those files are in a library other
 * than library 1 and the delete may go ahead, a second round trip reads
 * those libraries' rows, which reaching their buckets takes (#84).
 */
export async function checkUserDeletion(db: Database, id: string): Promise<UserDeletionCheck> {
  const [users, playlists] = await db.batch([
    db
      .select({ mayLoseAdmin: sql<number>`${mayLoseAdmin(id)}` })
      .from(subsonicUser)
      .where(eq(subsonicUser.id, id)),
    db
      .select({ libraryId: playlist.libraryId, r2Key: playlist.r2Key })
      .from(playlist)
      .where(eq(playlist.ownerId, id)),
  ]);

  const user = users[0];
  const refusal = user === undefined ? "not_found" : user.mayLoseAdmin ? null : "last_admin";
  // Another library's row is read only when a file is there, and the
  // delete will go ahead: a user of library 1 alone costs what it did.
  const others = [
    ...new Set(
      playlists.map((row) => row.libraryId).filter((libraryId) => libraryId !== DEFAULT_LIBRARY_ID),
    ),
  ];
  const libraries =
    refusal !== null || others.length === 0
      ? []
      : await db
          .select({
            id: library.id,
            kind: library.kind,
            path: library.path,
            endpoint: library.endpoint,
            bucket: library.bucket,
            credentials: library.credentials,
            writable: library.writable,
            state: library.state,
          })
          .from(library)
          .where(inArray(library.id, others));

  return {
    refusal,
    playlistFiles: playlists,
    libraries: new Map(libraries.map((row) => [row.id, row])),
  };
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
 *   `play_queue` and `bookmark`, and their `user_library` grants
 *   (migration 0009);
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
