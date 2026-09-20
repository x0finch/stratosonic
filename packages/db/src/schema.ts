import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * A key/value store for server-wide flags, shaped like Navidrome's `property`
 * table: `id` primary key and `value` text defaulting to the empty string. The
 * first-run bootstrap flag lives here.
 */
export const property = sqliteTable("property", {
  id: text("id").primaryKey(),
  value: text("value").notNull().default(""),
});

export type Property = typeof property.$inferSelect;
export type NewProperty = typeof property.$inferInsert;

/**
 * An account that can log in, shaped like Navidrome's `user` table
 * (`model/user.go`).
 *
 * `password` holds the AES-GCM ciphertext of the plaintext password, not a
 * hash: Subsonic token auth needs the plaintext back to verify `md5(password +
 * salt)` (ADR-0003). `token_epoch` is Navidrome's per-user counter, bumped on a
 * password change to invalidate issued tokens; it is carried here so the column
 * exists when it is needed.
 *
 * Navidrome stores its timestamps as SQLite datetimes. Stratosonic starts with
 * an empty user table — no user rows are migrated — so timestamps are stored as
 * epoch milliseconds instead, which is what the rest of the protocol speaks.
 */
export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    userName: text("user_name").notNull(),
    name: text("name").notNull().default(""),
    email: text("email").notNull().default(""),
    password: text("password").notNull().default(""),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    tokenEpoch: integer("token_epoch").notNull().default(0),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    lastAccessAt: integer("last_access_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    // Usernames are matched case-insensitively (Navidrome queries them
    // `COLLATE NOCASE`), so uniqueness has to ignore case as well: without
    // this, "Admin" and "admin" could both be created and a login would be
    // ambiguous.
    uniqueIndex("user_user_name_unique").on(sql`lower(${table.userName})`),
  ],
);

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
