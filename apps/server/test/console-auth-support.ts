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

/** The session cookies Better Auth sets for an `https` origin. */
export const SESSION_TOKEN_COOKIE = "__Secure-better-auth.session_token";
export const SESSION_DATA_COOKIE = "__Secure-better-auth.session_data";

/** Folds `Set-Cookie` headers into a `Cookie` header, as a browser would. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = header.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (expired || value === "") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  names(): string[] {
    return [...this.cookies.keys()].sort();
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

let nextAddress = 0;

/**
 * A request the console would send: same-origin, with the client address
 * Cloudflare adds. Each gets an address of its own unless it names one, so
 * only a test about the rate limiter ever meets it.
 */
export function consoleRequest(
  origin: string,
  path: string,
  init: { method?: string; body?: unknown; jar?: CookieJar; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers({
    origin,
    "cf-connecting-ip": `198.51.100.${(nextAddress++ % 250) + 1}`,
    ...init.headers,
  });
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (init.jar) {
    headers.set("cookie", init.jar.header());
  }

  return new Request(`${origin}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Sends a request to the Worker, or to an app built for one test. */
export type Send = (request: Request) => Response | Promise<Response>;

/** Signs in with a username and password, keeping the cookies in a jar. */
export async function signIn(
  send: Send,
  origin: string,
  userName: string,
  password: string,
  jar = new CookieJar(),
): Promise<{ response: Response; jar: CookieJar }> {
  const response = await send(
    consoleRequest(origin, "/api/auth/sign-in/username", {
      body: { username: userName, password },
    }),
  );
  jar.absorb(response);

  return { response, jar };
}
