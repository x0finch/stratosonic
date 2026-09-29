import { account, user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { decryptPassword } from "../src/auth/crypto";
import { database } from "../src/db";
import { encryptionKey, testEnv } from "./support";

/**
 * Helpers for the admin console's auth tests (#89): a D1 binding that records
 * every statement it runs, a cookie jar, and the password invariant.
 */

export interface RecordedStatement {
  readonly sql: string;
  /** D1's own `rows_read` / `rows_written`, which is what it bills. */
  readonly rowsRead: number;
  readonly rowsWritten: number;
  /** Statements sent in one `batch()` share a number; each single one has its own. */
  readonly roundTrip: number;
}

export interface CountingD1 {
  readonly binding: D1Database;
  readonly statements: RecordedStatement[];
  /** Round trips to D1: each single statement, and each batch, is one. */
  roundTrips(): number;
  reset(): void;
}

/**
 * Wraps a D1 binding and records what it is asked to run.
 *
 * Drizzle's D1 driver reads through `raw()`, which carries no meta, so `raw()`
 * is answered from `all()` (whose meta has the row counts) and each row turned
 * back into an array in column order. That is only sound without a join, whose
 * duplicate column names an object would collapse, so a join is refused.
 */
export function countingD1(inner: D1Database): CountingD1 {
  const statements: RecordedStatement[] = [];
  let roundTrip = 0;

  const record = (sql: string, meta: D1Meta | undefined, trip: number) => {
    statements.push({
      sql,
      rowsRead: meta?.rows_read ?? 0,
      rowsWritten: meta?.rows_written ?? 0,
      roundTrip: trip,
    });
  };

  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const run = async () => {
      const result = await statement.all<Record<string, unknown>>();
      record(sql, result.meta, ++roundTrip);
      return result;
    };

    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values), sql),
      all: run,
      run,
      async first(column?: string) {
        const row = (await run()).results[0] ?? null;
        return column === undefined ? row : (row?.[column] ?? null);
      },
      async raw(options?: { columnNames?: boolean }) {
        if (/\bjoin\b/i.test(sql)) {
          throw new Error(`countingD1 cannot answer a join through raw(): ${sql}`);
        }
        const { results } = await run();
        const rows = results.map((row) => Object.values(row));
        return options?.columnNames ? [Object.keys(results[0] ?? {}), ...rows] : rows;
      },
      inner: statement,
      sql,
    };

    return wrapped as unknown as D1PreparedStatement;
  };

  const unwrap = (statement: D1PreparedStatement) =>
    statement as unknown as { inner: D1PreparedStatement; sql: string };

  const binding = {
    prepare: (sql: string) => wrap(inner.prepare(sql), sql),
    async batch(batch: D1PreparedStatement[]) {
      const trip = ++roundTrip;
      const results = await inner.batch(batch.map((statement) => unwrap(statement).inner));
      results.forEach((result, index) => {
        record(unwrap(batch[index] as D1PreparedStatement).sql, result.meta, trip);
      });
      return results;
    },
    exec: (sql: string) => inner.exec(sql),
    dump: () => inner.dump(),
    withSession: () => {
      throw new Error("countingD1 does not wrap sessions");
    },
  };

  return {
    binding: binding as unknown as D1Database,
    statements,
    roundTrips: () => new Set(statements.map((statement) => statement.roundTrip)).size,
    reset() {
      statements.length = 0;
    },
  };
}

/** A statement as `<verb> <table>`, e.g. `select session`. */
export function shape(statement: RecordedStatement): string {
  const verb = statement.sql.split(" ")[0]?.toLowerCase();
  const table = statement.sql.match(/(?:from|into|update) "(\w+)"/i)?.[1];
  return `${verb} ${table}`;
}

/** What a run of statements cost, as the budget table reports it. */
export function cost(statements: readonly RecordedStatement[]) {
  return {
    statements: statements.length,
    roundTrips: new Set(statements.map((statement) => statement.roundTrip)).size,
    rowsRead: statements.reduce((sum, statement) => sum + statement.rowsRead, 0),
    rowsWritten: statements.reduce((sum, statement) => sum + statement.rowsWritten, 0),
  };
}

/**
 * The password invariant (#81): `user.password` and `account.password` hold
 * the same ciphertext, and it decrypts to `plaintext`.
 */
export async function expectPasswordInvariant(userId: string, plaintext: string): Promise<void> {
  const db = database(testEnv);
  const users = await db.select({ password: user.password }).from(user).where(eq(user.id, userId));
  const accounts = await db
    .select({ password: account.password, providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, userId));

  expect(users).toHaveLength(1);
  expect(accounts).toEqual([{ password: users[0]?.password, providerId: "credential" }]);
  await expect(decryptPassword(encryptionKey(), users[0]?.password ?? "")).resolves.toBe(plaintext);
  await expect(decryptPassword(encryptionKey(), accounts[0]?.password ?? "")).resolves.toBe(
    plaintext,
  );
}
