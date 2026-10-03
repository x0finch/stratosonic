import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { encryptPassword } from "../src/auth/crypto";
import { createConsoleAuth } from "../src/console-auth/auth";
import { createConsoleUser } from "../src/console-auth/credentials";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { findUserByUsername } from "../src/users/repository";
import { signIn } from "./console-auth-support";
import { encryptionKey, testEnv } from "./support";

/**
 * Migration 0008 (#89, rewritten by #99) over a database that already has
 * Subsonic users: the state a deployed Stratosonic is in when the admin
 * console arrives. It renames the Subsonic `user` table to `subsonic_user`,
 * rows, foreign keys and all, and changes nothing else of it; then it creates
 * Better Auth's standard tables, `user` among them, for the console's own
 * users.
 *
 * The migration runs against `MIGRATION_DB`, a database of this file's own
 * that the setup file leaves empty (vitest.config.ts), so the users and their
 * rows can be written between 0007 and 0008, and the schema read on both
 * sides of it.
 */

interface MigrationBindings {
  TEST_MIGRATIONS: D1Migration[];
  MIGRATION_DB: D1Database;
}

const { TEST_MIGRATIONS, MIGRATION_DB } = env as unknown as MigrationBindings;

/** The Subsonic users a server has before 0008: an admin and a listener. */
const EXISTING_USERS = [
  { id: "user-admin", userName: "Admin", isAdmin: 1, password: "before-0008" },
  { id: "user-listener", userName: "Listener", isAdmin: 0, password: "also-before" },
] as const;

/** The tables whose rows belong to a Subsonic user, by a cascading foreign key. */
const DEPENDENT_TABLES = ["annotation", "bookmark", "now_playing", "play_queue"] as const;

async function all(sql: string): Promise<Record<string, unknown>[]> {
  return (await MIGRATION_DB.prepare(sql).all<Record<string, unknown>>()).results;
}

/** What SQLite knows about the Subsonic user table, whatever it is called. */
async function subsonicUserSchema(table: string) {
  return {
    columns: await all(`SELECT * FROM pragma_table_xinfo('${table}') ORDER BY cid`),
    indexes: await all(
      `SELECT l."unique", l.origin, l.partial, i.seqno, i.cid, i.name AS column
         FROM pragma_index_list('${table}') l, pragma_index_info(l.name) i
        ORDER BY l.origin, i.seqno`,
    ),
    indexDefinitions: await all(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}' AND sql IS NOT NULL`,
    ),
  };
}

/** Every foreign key of the tables that belong to a Subsonic user. */
async function dependentForeignKeys() {
  return all(
    `SELECT m.name AS "from", f."from" AS "column", f."table", f."to", f.on_update, f.on_delete
       FROM sqlite_master m, pragma_foreign_key_list(m.name) f
      WHERE m.name IN (${DEPENDENT_TABLES.map((name) => `'${name}'`).join(", ")})
      ORDER BY m.name, f.id`,
  );
}

async function dependentRows() {
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const table of DEPENDENT_TABLES) {
    rows[table] = await all(`SELECT * FROM ${table} ORDER BY user_id`);
  }
  return rows;
}

let before: {
  schema: Awaited<ReturnType<typeof subsonicUserSchema>>;
  foreignKeys: Record<string, unknown>[];
  users: Record<string, unknown>[];
  dependents: Record<string, Record<string, unknown>[]>;
};

beforeAll(async () => {
  const upTo0007 = TEST_MIGRATIONS.filter((migration) => migration.name < "0008");
  expect(upTo0007).toHaveLength(8);
  await applyD1Migrations(MIGRATION_DB, upTo0007);

  const users = await Promise.all(
    EXISTING_USERS.map(async (seed, index) =>
      MIGRATION_DB.prepare(
        "INSERT INTO user (id, user_name, name, password, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        seed.id,
        seed.userName,
        seed.userName,
        await encryptPassword(encryptionKey(), seed.password),
        seed.isAdmin,
        1_000 + index,
        2_000 + index,
      ),
    ),
  );
  await MIGRATION_DB.batch([
    ...users,
    // A row of each kind that belongs to a user, which the rename must keep
    // pointing at its user.
    MIGRATION_DB.prepare(
      "INSERT INTO annotation (user_id, item_id, item_type, starred, play_count) VALUES ('user-admin', 'tr-1', 'track', 1, 3)",
    ),
    MIGRATION_DB.prepare(
      "INSERT INTO bookmark (user_id, track_id, position, created_at, changed_at) VALUES ('user-admin', 'tr-1', 42, 1, 1)",
    ),
    MIGRATION_DB.prepare(
      "INSERT INTO now_playing (user_id, track_id, player_name, started_at, expires_at) VALUES ('user-listener', 'tr-1', 'test', 1, 2)",
    ),
    MIGRATION_DB.prepare(
      "INSERT INTO play_queue (user_id, track_ids, position, changed_by, changed_at) VALUES ('user-listener', '[\"tr-1\"]', 0, 'test', 1)",
    ),
  ]);
  before = {
    schema: await subsonicUserSchema("user"),
    foreignKeys: await dependentForeignKeys(),
    users: await all("SELECT * FROM user ORDER BY id"),
    dependents: await dependentRows(),
  };

  await applyD1Migrations(MIGRATION_DB, TEST_MIGRATIONS);
});

describe("migration 0008 over existing Subsonic users", () => {
  it("renames user to subsonic_user, with the same columns", async () => {
    const after = await subsonicUserSchema("subsonic_user");

    expect(after.columns).toEqual(before.schema.columns);
    expect(after.columns.map((column) => column.name)).toEqual([
      "id",
      "user_name",
      "name",
      "email",
      "password",
      "is_admin",
      "token_epoch",
      "last_login_at",
      "last_access_at",
      "created_at",
      "updated_at",
    ]);
  });

  it("keeps its indexes, the case-insensitive one on the same expression", async () => {
    const after = await subsonicUserSchema("subsonic_user");

    expect(after.indexes).toEqual(before.schema.indexes);
    expect(before.schema.indexDefinitions).toEqual([
      { sql: 'CREATE UNIQUE INDEX `user_user_name_unique` ON `user` (lower("user_name"))' },
    ]);
    expect(after.indexDefinitions).toEqual([
      {
        sql: 'CREATE UNIQUE INDEX `subsonic_user_user_name_unique` ON `subsonic_user` (lower("user_name"))',
      },
    ]);
  });

  it("keeps every row, of the users and of what belongs to them", async () => {
    expect(await all("SELECT * FROM subsonic_user ORDER BY id")).toEqual(before.users);
    expect(await dependentRows()).toEqual(before.dependents);
    expect(Object.values(before.dependents).every((rows) => rows.length === 1)).toBe(true);
  });

  it("points every foreign key that named user at subsonic_user, and changes nothing else", async () => {
    const after = await dependentForeignKeys();

    expect(before.foreignKeys.map((key) => key.table)).toEqual(DEPENDENT_TABLES.map(() => "user"));
    expect(after).toEqual(before.foreignKeys.map((key) => ({ ...key, table: "subsonic_user" })));
    expect(await all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("still cascades a Subsonic user's deletion to what belongs to them", async () => {
    await MIGRATION_DB.batch([
      MIGRATION_DB.prepare(
        "INSERT INTO subsonic_user (id, user_name, created_at, updated_at) VALUES ('user-gone', 'Gone', 0, 0)",
      ),
      MIGRATION_DB.prepare(
        "INSERT INTO annotation (user_id, item_id, item_type) VALUES ('user-gone', 'tr-2', 'track')",
      ),
    ]);

    await MIGRATION_DB.prepare("DELETE FROM subsonic_user WHERE id = 'user-gone'").run();

    expect(await all("SELECT * FROM annotation WHERE user_id = 'user-gone'")).toEqual([]);
  });

  it("leaves the Subsonic lookup finding its users by name, in any case", async () => {
    const migrated: Env = { ...testEnv, DB: MIGRATION_DB };

    expect((await findUserByUsername(database(migrated), "ADMIN"))?.id).toBe("user-admin");
  });

  it("creates Better Auth's standard tables, empty", async () => {
    const tables = await all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('user', 'session', 'account', 'verification', 'rate_limit') ORDER BY name",
    );

    expect(tables.map((row) => row.name)).toEqual([
      "account",
      "rate_limit",
      "session",
      "user",
      "verification",
    ]);
    for (const { name } of tables) {
      const count = await MIGRATION_DB.prepare(`SELECT count(*) AS n FROM ${name}`).first("n");
      expect(count, String(name)).toBe(0);
    }
    expect((await all("SELECT name FROM pragma_table_xinfo('user')")).map((c) => c.name)).toEqual([
      "id",
      "name",
      "display_username",
      "username",
      "email",
      "email_verified",
      "image",
      "role",
      "created_at",
      "updated_at",
    ]);
  });

  it("refers from the console's tables to user, and never to subsonic_user", async () => {
    const references = await all(
      `SELECT m.name AS "from", f."table" AS "to", f.on_delete FROM sqlite_master m, pragma_foreign_key_list(m.name) f
        WHERE m.name IN ('user', 'session', 'account', 'verification', 'rate_limit') ORDER BY m.name`,
    );

    expect(references).toEqual([
      { from: "account", to: "user", on_delete: "CASCADE" },
      { from: "session", to: "user", on_delete: "CASCADE" },
    ]);
  });

  it("lets no Subsonic user sign in to the console", async () => {
    const origin = "https://migrated.stratosonic.test";
    const auth = await createConsoleAuth({ db: MIGRATION_DB, passphrase: encryptionKey(), origin });
    const send = (request: Request) => auth.handler(request);

    expect((await signIn(send, origin, "admin", "before-0008")).response.status).toBe(401);
    expect((await signIn(send, origin, "listener", "also-before")).response.status).toBe(401);
  });

  it("derives a console user's sign-in name and placeholder email, served from an index", async () => {
    const migrated: Env = { ...testEnv, DB: MIGRATION_DB };
    await createConsoleUser(database(migrated), encryptionKey(), {
      username: "Owner",
      password: "pw",
      role: "owner",
    });

    const row = await MIGRATION_DB.prepare(
      "SELECT name, display_username, username, email, role FROM user",
    ).first();
    const plan = await all("EXPLAIN QUERY PLAN SELECT * FROM user WHERE username = 'owner'");

    expect(row).toEqual({
      name: "Owner",
      display_username: "Owner",
      username: "owner",
      email: "owner@console.invalid",
      role: "owner",
    });
    expect(plan.map((result) => result.detail).join("\n")).toMatch(
      /USING INDEX user_username_unique/,
    );
    expect(await all("SELECT * FROM subsonic_user ORDER BY id")).toEqual(before.users);
  });

  it("takes a role for every console user, and at most one owner", async () => {
    const insert = (id: string, role: string | null) =>
      MIGRATION_DB.prepare(
        "INSERT INTO user (id, name, display_username, role, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
      )
        .bind(id, id, id, role)
        .run();

    await expect(insert("no-role", null)).rejects.toThrow(/NOT NULL constraint failed: user\.role/);
    await expect(insert("second-owner", "owner")).rejects.toThrow(/UNIQUE constraint failed/);
    // Any other role can be stored, twice too: console-auth/permissions.ts
    // decides what it grants.
    await insert("reader-1", "read-only");
    await insert("reader-2", "read-only");

    expect(await all("SELECT display_username, role FROM user ORDER BY display_username")).toEqual([
      { display_username: "Owner", role: "owner" },
      { display_username: "reader-1", role: "read-only" },
      { display_username: "reader-2", role: "read-only" },
    ]);
  });
});
