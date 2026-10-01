import { consoleAccount } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { subsonicToken } from "../src/auth/crypto";
import { createConsoleUser } from "../src/console-auth/credentials";
import { verifyConsolePassword } from "../src/console-auth/password-hash";
import { OWNER_ROLE, type Role } from "../src/console-auth/permissions";
import { database } from "../src/db";
import { encryptionKey, type JsonEnvelope, testEnv } from "./support";

/**
 * Helpers for the admin console's auth tests (#89, #99): a D1 binding that
 * records every statement it runs, a cookie jar, the console's users and
 * their stored passwords.
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
 * duplicate column names an object would collapse (`track.id` and `album.id`
 * are both `id`), so a joined select runs twice: `all()` for D1's own
 * `rows_read`, recorded as the one round trip it stands for, and `raw()` for
 * the rows, column for column. Reading twice changes nothing, so only a
 * select is answered that way; any other joined statement is refused.
 *
 * A batch needs none of this: D1 answers each of its statements with its
 * meta, and Drizzle reads a batched result from the row objects itself.
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
          if (!/^\s*select\b/i.test(sql)) {
            throw new Error(`countingD1 cannot answer a joined write through raw(): ${sql}`);
          }
          await run();
          return options?.columnNames
            ? statement.raw({ columnNames: true })
            : statement.raw({ columnNames: false });
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
 * A role no release defines, which grants no permission: the one the console
 * users a test needs besides its owner get, since the database takes at most
 * one owner.
 */
export const GUEST_ROLE = "guest";

/**
 * Creates a console user with a known password, the way setup does: through
 * the one writer of console users (console-auth/credentials.ts), as the owner
 * unless told otherwise. A console user is not a Subsonic user; `seedUser`
 * (test/support.ts) creates those.
 */
export async function seedConsoleUser(
  username: string,
  password: string,
  role: string = OWNER_ROLE,
): Promise<string> {
  const id = await createConsoleUser(database(testEnv), encryptionKey(), {
    username,
    password,
    // The writer takes the roles this release knows; a test also writes
    // others, which grant nothing.
    role: role as Role,
  });
  if (id === null) {
    throw new Error(`a console user named ${username}, or an owner, already exists`);
  }

  return id;
}

/**
 * That a console user has exactly one credential account, holding a peppered
 * hash (ADR-0007) of `plaintext` and of nothing else.
 */
export async function expectConsolePassword(
  consoleUserId: string,
  plaintext: string,
): Promise<void> {
  const accounts = await database(testEnv)
    .select({ password: consoleAccount.password, providerId: consoleAccount.providerId })
    .from(consoleAccount)
    .where(eq(consoleAccount.userId, consoleUserId));

  expect(accounts).toMatchObject([{ providerId: "credential" }]);
  const stored = accounts[0]?.password ?? "";
  expect(stored).toMatch(/^hmac-sha256\$v1\$/);
  expect(await verifyConsolePassword(encryptionKey(), stored, plaintext)).toBe(true);
  expect(await verifyConsolePassword(encryptionKey(), stored, `${plaintext}?`)).toBe(false);
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

/**
 * What a Subsonic `ping` with these credentials answers: `"ok"`, or the
 * Subsonic error code, 40 for a wrong username or password. Both of
 * Subsonic's ways to send a password are tried, the token (`t` and `s`) and
 * the plain `p`, and they must agree.
 */
export async function subsonicPing(
  send: Send,
  origin: string,
  username: string,
  password: string,
): Promise<"ok" | number> {
  const salt = "5a17c0de";
  const answers: ("ok" | number)[] = [];
  for (const credentials of [
    { t: await subsonicToken(password, salt), s: salt },
    { p: password },
  ]) {
    const query = new URLSearchParams({ u: username, v: "1.16.1", c: "test", f: "json" });
    for (const [name, value] of Object.entries(credentials)) {
      query.set(name, value);
    }
    const response = await send(new Request(`${origin}/rest/ping?${query}`));
    const body = ((await response.json()) as JsonEnvelope)["subsonic-response"];
    answers.push(body.status === "ok" ? "ok" : (body.error?.code ?? -1));
  }

  expect(answers[1], "p= and t/s disagree").toBe(answers[0]);
  return answers[0] ?? -1;
}
