import { sqliteTable, text } from "drizzle-orm/sqlite-core";

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
