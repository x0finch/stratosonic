import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptPassword, encryptPassword } from "../src/auth/crypto";
import { createConsoleAuth } from "../src/console-auth/auth";
import { signIn } from "./console-auth-support";
import { encryptionKey } from "./support";

/**
 * Migration 0008 (#89) over a database that already has users: the state a
 * deployed Stratosonic is in when the admin console arrives. It adds Better
 * Auth's columns and tables, and backfills a credential account per user.
 *
 * The migration runs against `MIGRATION_DB`, a database of this file's own
 * that the setup file leaves empty (vitest.config.ts), so the users can be
 * written between 0007 and 0008.
 */

interface MigrationBindings {
  TEST_MIGRATIONS: D1Migration[];
  MIGRATION_DB: D1Database;
}

const { TEST_MIGRATIONS, MIGRATION_DB } = env as unknown as MigrationBindings;

/** The users a server has before 0008: an admin and a listener. */
const EXISTING_USERS = [
  { id: "user-admin", userName: "Admin", isAdmin: 1, password: "before-0008" },
  { id: "user-listener", userName: "Listener", isAdmin: 0, password: "also-before" },
] as const;

beforeAll(async () => {
  const before = TEST_MIGRATIONS.filter((migration) => migration.name < "0008");
  expect(before).toHaveLength(TEST_MIGRATIONS.length - 1);
  await applyD1Migrations(MIGRATION_DB, before);

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

  await applyD1Migrations(MIGRATION_DB, TEST_MIGRATIONS);
});

describe("migration 0008 over existing users", () => {
  it("adds only generated or defaulted columns, so no existing column changes", async () => {
    const columns = await MIGRATION_DB.prepare(
      "SELECT name, type, \"notnull\", dflt_value, hidden FROM pragma_table_xinfo('user')",
    ).all();

    // hidden = 2 marks a VIRTUAL generated column: stored nowhere, written by
    // no one.
    expect(columns.results).toEqual([
      { name: "id", type: "TEXT", notnull: 1, dflt_value: null, hidden: 0 },
      { name: "user_name", type: "TEXT", notnull: 1, dflt_value: null, hidden: 0 },
      { name: "name", type: "TEXT", notnull: 1, dflt_value: "''", hidden: 0 },
      { name: "email", type: "TEXT", notnull: 1, dflt_value: "''", hidden: 0 },
      { name: "password", type: "TEXT", notnull: 1, dflt_value: "''", hidden: 0 },
      { name: "is_admin", type: "INTEGER", notnull: 1, dflt_value: "false", hidden: 0 },
      { name: "token_epoch", type: "INTEGER", notnull: 1, dflt_value: "0", hidden: 0 },
      { name: "last_login_at", type: "INTEGER", notnull: 0, dflt_value: null, hidden: 0 },
      { name: "last_access_at", type: "INTEGER", notnull: 0, dflt_value: null, hidden: 0 },
      { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, hidden: 0 },
      { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, hidden: 0 },
      { name: "username", type: "TEXT", notnull: 0, dflt_value: null, hidden: 2 },
      { name: "auth_email", type: "TEXT", notnull: 0, dflt_value: null, hidden: 2 },
      { name: "email_verified", type: "INTEGER", notnull: 1, dflt_value: "false", hidden: 0 },
      { name: "image", type: "TEXT", notnull: 0, dflt_value: null, hidden: 0 },
    ]);
  });

  it("derives the sign-in name and the placeholder email from user_name", async () => {
    const users = await MIGRATION_DB.prepare(
      "SELECT user_name, username, auth_email, email, email_verified, image FROM user ORDER BY id",
    ).all();

    expect(users.results).toEqual([
      {
        user_name: "Admin",
        username: "admin",
        auth_email: "admin@users.invalid",
        email: "",
        email_verified: 0,
        image: null,
      },
      {
        user_name: "Listener",
        username: "listener",
        auth_email: "listener@users.invalid",
        email: "",
        email_verified: 0,
        image: null,
      },
    ]);
  });

  it("backfills one credential account per user, with the user's own ciphertext", async () => {
    const accounts = await MIGRATION_DB.prepare(
      `SELECT a.id, a.account_id, a.provider_id, a.user_id, a.password, u.password AS user_password,
              a.created_at, a.updated_at
         FROM account a JOIN user u ON u.id = a.user_id ORDER BY a.user_id`,
    ).all<Record<string, unknown>>();

    expect(accounts.results.map(({ password, user_password, ...row }) => row)).toEqual([
      {
        id: "user-admin",
        account_id: "user-admin",
        provider_id: "credential",
        user_id: "user-admin",
        created_at: 1_000,
        updated_at: 2_000,
      },
      {
        id: "user-listener",
        account_id: "user-listener",
        provider_id: "credential",
        user_id: "user-listener",
        created_at: 1_001,
        updated_at: 2_001,
      },
    ]);

    for (const [index, row] of accounts.results.entries()) {
      expect(row.password).toBe(row.user_password);
      await expect(decryptPassword(encryptionKey(), String(row.password))).resolves.toBe(
        EXISTING_USERS[index]?.password,
      );
    }
  });

  it("creates the session tables empty", async () => {
    for (const table of ["session", "verification", "rate_limit"]) {
      const count = await MIGRATION_DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n");
      expect(count, table).toBe(0);
    }
  });

  it("lets every existing user sign in to the console with their Subsonic password", async () => {
    const origin = "https://migrated.stratosonic.test";
    const auth = await createConsoleAuth({ db: MIGRATION_DB, passphrase: encryptionKey(), origin });
    const send = (request: Request) => auth.handler(request);

    const admin = await signIn(send, origin, "admin", "before-0008");
    const listener = await signIn(send, origin, "LISTENER", "also-before");

    expect(await admin.response.json()).toMatchObject({
      user: { id: "user-admin", displayUsername: "Admin", isAdmin: true },
    });
    expect(await listener.response.json()).toMatchObject({
      user: { id: "user-listener", displayUsername: "Listener", isAdmin: false },
    });
    expect((await signIn(send, origin, "admin", "wrong")).response.status).toBe(401);
  });

  it("serves the sign-in lookup from an index", async () => {
    const plan = await MIGRATION_DB.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM user WHERE username = ?",
    )
      .bind("admin")
      .all<{ detail: string }>();

    expect(plan.results.map((row) => row.detail).join("\n")).toMatch(
      /USING INDEX user_username_unique/,
    );
  });

  it("follows a rename without a second write", async () => {
    await MIGRATION_DB.prepare("UPDATE user SET user_name = 'Listening' WHERE id = ?")
      .bind("user-listener")
      .run();
    const renamed = await MIGRATION_DB.prepare("SELECT username, auth_email FROM user WHERE id = ?")
      .bind("user-listener")
      .first();
    await MIGRATION_DB.prepare("UPDATE user SET user_name = 'Listener' WHERE id = ?")
      .bind("user-listener")
      .run();

    expect(renamed).toEqual({ username: "listening", auth_email: "listening@users.invalid" });
  });
});
