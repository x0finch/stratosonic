/**
 * SPIKE #86, question 1: migration 0008 over a database that already has
 * users - the shape a deployed Stratosonic is in when this lands.
 */

import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encryptPassword } from "../src/auth/crypto";
import { createConsoleAuth, deriveAuthSecret } from "../src/console-auth/auth";
import { AUTH_ORIGIN, authRequest } from "./console-auth-support";
import { encryptionKey, testEnv } from "./support";

const { TEST_MIGRATIONS, MIGRATION_DB } = env as unknown as {
  TEST_MIGRATIONS: D1Migration[];
  MIGRATION_DB: D1Database;
};

describe("question 1: migrating a deployed database", () => {
  it("backfills a credential account per existing user, and they can sign in", async () => {
    const before = TEST_MIGRATIONS.filter((migration) => !migration.name.startsWith("0008"));
    expect(before).toHaveLength(TEST_MIGRATIONS.length - 1);
    await applyD1Migrations(MIGRATION_DB, before);

    const ciphertext = await encryptPassword(encryptionKey(), "before-0008");
    await MIGRATION_DB.batch(
      ["Admin", "Listener"].map((name, index) =>
        MIGRATION_DB.prepare(
          "INSERT INTO user (id, user_name, name, password, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(`user-${index}`, name, name, ciphertext, index === 0 ? 1 : 0, 1000 + index, 1000),
      ),
    );

    await applyD1Migrations(MIGRATION_DB, TEST_MIGRATIONS);

    const accounts = await MIGRATION_DB.prepare(
      "SELECT a.account_id, a.provider_id, a.user_id, a.password = u.password AS same, u.username, u.auth_email, u.email_verified, u.is_admin FROM account a JOIN user u ON u.id = a.user_id ORDER BY a.user_id",
    ).all();
    expect(accounts.results).toEqual([
      {
        account_id: "user-0",
        provider_id: "credential",
        user_id: "user-0",
        same: 1,
        username: "admin",
        auth_email: "admin@users.invalid",
        email_verified: 0,
        is_admin: 1,
      },
      {
        account_id: "user-1",
        provider_id: "credential",
        user_id: "user-1",
        same: 1,
        username: "listener",
        auth_email: "listener@users.invalid",
        email_verified: 0,
        is_admin: 0,
      },
    ]);

    const auth = createConsoleAuth(testEnv, {
      db: MIGRATION_DB,
      secret: await deriveAuthSecret(encryptionKey()),
      baseURL: AUTH_ORIGIN,
    });
    const response = await auth.handler(
      authRequest("/sign-in/username", { body: { username: "Listener", password: "before-0008" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { id: "user-1", displayUsername: "Listener", isAdmin: false },
    });
  });
});
