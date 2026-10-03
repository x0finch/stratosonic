import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";
import journal from "../migrations/meta/_journal.json";
import * as schema from "../src/schema";

/**
 * Whether `schema.ts` and the migrations say the same thing. Some migrations
 * are written by hand (0008's rename, 0009's index swaps), so the SQL is not
 * always drizzle-kit's, but the snapshot beside each one is: this is
 * `drizzle-kit generate` finding no change, run on every test.
 *
 * apps/server's migration tests then prove the SQL leaves the database the
 * schema declares (migration-0009.test.ts).
 */

const latest = journal.entries.at(-1);

describe("the latest migration snapshot", () => {
  it("is the last migration in the journal", () => {
    expect(latest?.idx).toBe(journal.entries.length - 1);
    expect(latest?.tag).toMatch(/^\d{4}_/);
  });

  it("matches schema.ts, so drizzle-kit would generate nothing", async () => {
    const number = latest?.tag.slice(0, 4);
    const snapshot = (await import(`../migrations/meta/${number}_snapshot.json`)).default;
    const current = await generateSQLiteDrizzleJson(schema, snapshot.id);

    expect(await generateSQLiteMigration(snapshot, current)).toEqual([]);
  });
});
