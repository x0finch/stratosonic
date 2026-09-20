import { type NewUser, type User, user } from "@stratosonic/db";
import { eq, sql } from "drizzle-orm";
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
