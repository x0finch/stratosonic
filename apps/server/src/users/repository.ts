import { type NewUser, type User, user } from "@stratosonic/db";
import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db";

/**
 * Reads and writes of the `user` table. Everything that touches users goes
 * through here, so the case-insensitive lookup and the column names live in one
 * place.
 */

/**
 * Finds a user by name, ignoring case — Navidrome matches `user_name` with
 * `COLLATE NOCASE` (persistence/user_repository.go). The comparison is written
 * the same way as the table's unique index so the index can serve it.
 */
export async function findUserByUsername(db: Database, userName: string): Promise<User | null> {
  const rows = await db
    .select()
    .from(user)
    .where(sql`lower(${user.userName}) = lower(${userName})`)
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
export async function findFirstAdmin(db: Database): Promise<User | null> {
  const rows = await db
    .select()
    .from(user)
    .where(eq(user.isAdmin, true))
    .orderBy(asc(user.updatedAt), asc(user.id))
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
export async function insertUser(db: Database, values: NewUser): Promise<void> {
  await db.insert(user).values(values);
}

/** Counts every user, which is how the first-run bootstrap knows it is first. */
export async function countUsers(db: Database): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)` }).from(user);

  return rows[0]?.count ?? 0;
}

export async function updateLastAccessAt(db: Database, id: string, at: Date): Promise<void> {
  await db.update(user).set({ lastAccessAt: at }).where(eq(user.id, id));
}
