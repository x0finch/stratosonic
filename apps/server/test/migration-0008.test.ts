import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { encryptPassword } from "../src/auth/crypto";
import { createConsoleAuth } from "../src/console-auth/auth";
import { createOperator } from "../src/console-auth/credentials";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { signIn } from "./console-auth-support";
import { encryptionKey, testEnv } from "./support";

/**
 * Migration 0008 (#89, rewritten by #99) over a database that already has
 * Subsonic users: the state a deployed Stratosonic is in when the admin
 * console arrives. It adds the operators' tables, the console's own accounts,
 * and leaves the Subsonic `user` table exactly as 0007 left it: no column,
 * index or row of it changes.
 *
 * The migration runs against `MIGRATION_DB`, a database of this file's own
 * that the setup file leaves empty (vitest.config.ts), so the users can be
 * written between 0007 and 0008, and the schema read on both sides of it.
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

/** Everything SQLite knows about the `user` table: its columns and its indexes. */
async function userSchema() {
  const columns = await MIGRATION_DB.prepare(
    "SELECT * FROM pragma_table_xinfo('user') ORDER BY cid",
  ).all();
  const objects = await MIGRATION_DB.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name = 'user' ORDER BY name",
  ).all();
  const indexes = await MIGRATION_DB.prepare(
    "SELECT * FROM pragma_index_list('user') ORDER BY name",
  ).all();

  return { columns: columns.results, objects: objects.results, indexes: indexes.results };
}

async function userRows() {
  return (await MIGRATION_DB.prepare("SELECT * FROM user ORDER BY id").all()).results;
}

let before: Awaited<ReturnType<typeof userSchema>>;
let rowsBefore: Record<string, unknown>[];

beforeAll(async () => {
  const upTo0007 = TEST_MIGRATIONS.filter((migration) => migration.name < "0008");
  expect(upTo0007).toHaveLength(TEST_MIGRATIONS.length - 1);
  await applyD1Migrations(MIGRATION_DB, upTo0007);

  await MIGRATION_DB.batch(
    await Promise.all(
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
    ),
  );
  before = await userSchema();
  rowsBefore = await userRows();

  await applyD1Migrations(MIGRATION_DB, TEST_MIGRATIONS);
});

describe("migration 0008 over existing Subsonic users", () => {
  it("leaves the user table's columns exactly as 0007 left them", async () => {
    const after = await userSchema();

    expect(after.columns).toEqual(before.columns);
    // As 0001 created them: nothing generated or hidden, and no Better Auth
    // column.
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
    expect(after.columns.every((column) => column.hidden === 0)).toBe(true);
  });

  it("leaves the user table's definition and indexes byte for byte as they were", async () => {
    const after = await userSchema();

    expect(after.objects).toEqual(before.objects);
    expect(after.indexes).toEqual(before.indexes);
    expect(after.objects.map((object) => object.name)).toEqual([
      "sqlite_autoindex_user_1",
      "user",
      "user_user_name_unique",
    ]);
  });

  it("leaves every user row as it was, and backfills nothing", async () => {
    expect(await userRows()).toEqual(rowsBefore);
    for (const table of ["operator", "operator_account"]) {
      const count = await MIGRATION_DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n");
      expect(count, table).toBe(0);
    }
  });

  it("creates the operators' tables, and the rate limiter's, empty", async () => {
    const tables = await MIGRATION_DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'operator%' OR name = 'rate_limit') ORDER BY name",
    ).all<{ name: string }>();

    expect(tables.results.map((row) => row.name)).toEqual([
      "operator",
      "operator_account",
      "operator_session",
      "operator_verification",
      "rate_limit",
    ]);
    for (const { name } of tables.results) {
      const count = await MIGRATION_DB.prepare(`SELECT count(*) AS n FROM ${name}`).first("n");
      expect(count, name).toBe(0);
    }
  });

  it("refers from the operators' tables to operator, and never to user", async () => {
    const references = await MIGRATION_DB.prepare(
      `SELECT m.name AS "from", f."table" AS "to" FROM sqlite_master m, pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND (m.name LIKE 'operator%' OR m.name = 'rate_limit') ORDER BY m.name`,
    ).all();

    expect(references.results).toEqual([
      { from: "operator_account", to: "operator" },
      { from: "operator_session", to: "operator" },
    ]);
  });

  it("lets no Subsonic user sign in to the console", async () => {
    const origin = "https://migrated.stratosonic.test";
    const auth = await createConsoleAuth({ db: MIGRATION_DB, passphrase: encryptionKey(), origin });
    const send = (request: Request) => auth.handler(request);

    expect((await signIn(send, origin, "admin", "before-0008")).response.status).toBe(401);
    expect((await signIn(send, origin, "listener", "also-before")).response.status).toBe(401);
  });

  it("derives an operator's sign-in name and placeholder email, and serves the lookup from an index", async () => {
    const migrated: Env = { ...testEnv, DB: MIGRATION_DB };
    await createOperator(database(migrated), encryptionKey(), {
      username: "Owner",
      password: "pw",
    });

    const row = await MIGRATION_DB.prepare(
      "SELECT name, display_username, username, email FROM operator",
    ).first();
    const plan = await MIGRATION_DB.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM operator WHERE username = ?",
    )
      .bind("owner")
      .all<{ detail: string }>();

    expect(row).toEqual({
      name: "Owner",
      display_username: "Owner",
      username: "owner",
      email: "owner@console.invalid",
    });
    expect(plan.results.map((result) => result.detail).join("\n")).toMatch(
      /USING INDEX operator_username_unique/,
    );
    expect(await userRows()).toEqual(rowsBefore);
  });
});
