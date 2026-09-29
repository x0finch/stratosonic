/**
 * SPIKE #86 - helpers for the Better Auth tests: a D1 binding that records
 * every statement it runs (with D1's own rows-read / rows-written meta), and a
 * cookie jar small enough to read.
 */

import { createConsoleAuth, deriveAuthSecret } from "../src/console-auth/auth";
import { createUserWithCredential } from "../src/console-auth/credentials";
import { database } from "../src/db";
import { encryptionKey, testEnv } from "./support";

export const AUTH_ORIGIN = "https://stratosonic.test";

export interface RecordedQuery {
  readonly sql: string;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  /** Statements sent together in one `batch()` share a number; singles get their own. */
  readonly roundTrip: number;
}

export interface CountingD1 {
  readonly binding: D1Database;
  readonly queries: RecordedQuery[];
  /** Round trips to D1: each single statement, and each batch, is one. */
  roundTrips(): number;
  reset(): void;
}

/**
 * Wraps a D1 binding. Drizzle's D1 driver reads through `raw()`, which returns
 * no meta, so `raw()` is answered from `all()` (whose meta carries the row
 * counts) and the objects turned back into arrays, in column order.
 */
export function countingD1(inner: D1Database): CountingD1 {
  const queries: RecordedQuery[] = [];
  let roundTrip = 0;

  const record = (sql: string, meta: D1Meta | undefined, trip: number) => {
    queries.push({
      sql,
      rowsRead: meta?.rows_read ?? 0,
      rowsWritten: meta?.rows_written ?? 0,
      roundTrip: trip,
    });
  };

  const wrapStatement = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = {
      bind: (...values: unknown[]) => wrapStatement(statement.bind(...values), sql),
      async all() {
        const result = await statement.all();
        record(sql, result.meta, ++roundTrip);
        return result;
      },
      async run() {
        const result = await statement.run();
        record(sql, result.meta, ++roundTrip);
        return result;
      },
      async first(column?: string) {
        const result = await statement.all();
        record(sql, result.meta, ++roundTrip);
        const row = (result.results[0] ?? null) as Record<string, unknown> | null;
        return column === undefined ? row : (row?.[column] ?? null);
      },
      async raw(options?: { columnNames?: boolean }) {
        if (/\bjoin\b/i.test(sql)) {
          throw new Error(`countingD1 cannot answer a join through all(): ${sql}`);
        }
        const result = await statement.all();
        record(sql, result.meta, ++roundTrip);
        const rows = result.results.map((row) => Object.values(row as Record<string, unknown>));
        if (options?.columnNames) {
          const first = result.results[0] as Record<string, unknown> | undefined;
          return [first ? Object.keys(first) : [], ...rows];
        }
        return rows;
      },
      __inner: statement,
      __sql: sql,
    };
    return wrapped as unknown as D1PreparedStatement;
  };

  const binding = {
    prepare: (sql: string) => wrapStatement(inner.prepare(sql), sql),
    async batch(statements: D1PreparedStatement[]) {
      const trip = ++roundTrip;
      const unwrapped = statements.map(
        (statement) => (statement as unknown as { __inner: D1PreparedStatement }).__inner,
      );
      const results = await inner.batch(unwrapped);
      results.forEach((result, index) => {
        record((statements[index] as unknown as { __sql: string }).__sql, result.meta, trip);
      });
      return results;
    },
    exec: (sql: string) => inner.exec(sql),
    withSession: () => {
      throw new Error("not used");
    },
    dump: () => inner.dump(),
  };

  return {
    binding: binding as unknown as D1Database,
    queries,
    roundTrips: () => new Set(queries.map((query) => query.roundTrip)).size,
    reset() {
      queries.length = 0;
    },
  };
}

/** The totals the budget table reports. */
export function totals(queries: readonly RecordedQuery[]) {
  return {
    statements: queries.length,
    roundTrips: new Set(queries.map((query) => query.roundTrip)).size,
    rowsRead: queries.reduce((sum, query) => sum + query.rowsRead, 0),
    rowsWritten: queries.reduce((sum, query) => sum + query.rowsWritten, 0),
  };
}

/** A console auth instance over a counting D1. */
export async function countedAuth(overrides: { usePasswordHooks?: boolean } = {}) {
  const d1 = countingD1(testEnv.DB);
  const auth = createConsoleAuth(testEnv, {
    db: d1.binding,
    secret: await deriveAuthSecret(encryptionKey()),
    baseURL: AUTH_ORIGIN,
    ...overrides,
  });
  // Let Better Auth finish building its context before anything is counted.
  await auth.$context;
  return { auth, d1 };
}

export function createUser(userName: string, password: string, isAdmin = false) {
  return createUserWithCredential(database(testEnv), encryptionKey(), {
    userName,
    password,
    isAdmin,
  });
}

/** Folds `Set-Cookie` headers into a `Cookie` header, dropping expired cookies. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()));
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

  names(): string[] {
    return [...this.cookies.keys()];
  }

  delete(name: string): void {
    this.cookies.delete(name);
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

let nextAddress = 0;

export function authRequest(
  path: string,
  init: { method?: string; body?: unknown; jar?: CookieJar; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers({
    origin: AUTH_ORIGIN,
    // A fresh client address per request, so only the rate-limit test itself
    // ever meets the limiter.
    "cf-connecting-ip": `198.51.100.${(nextAddress++ % 250) + 1}`,
    ...init.headers,
  });
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (init.jar) {
    headers.set("cookie", init.jar.header());
  }
  return new Request(`${AUTH_ORIGIN}/api/auth${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
