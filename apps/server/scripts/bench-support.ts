/**
 * What the request benches share (bench-console-auth.ts, bench-file-uploads.ts):
 * a stand-in for D1 on `node:sqlite`, migrated as production is, that keeps
 * the time spent inside it apart; requests to the `/api` sub-app as the
 * console sends them; and the timing loop and its table.
 *
 * On Workers, D1 executes on its own machine and the Worker only waits for
 * it, so a sample is the request's time less the stand-in's.
 */

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../../../packages/db/migrations/", import.meta.url);
const WARM_UP = 20;

/* --------------------------------------------- a D1 stand-in, timed -- */

let d1Ms = 0;
let d1Statements = 0;

function timed<T>(work: () => T): T {
  const start = performance.now();
  try {
    return work();
  } finally {
    d1Ms += performance.now() - start;
    d1Statements++;
  }
}

type Param = null | number | bigint | string | Uint8Array;

function toParam(value: unknown): Param {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as Param;
}

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Param[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values.map(toParam));
  }

  private execute() {
    const statement = this.db.prepare(this.sql);
    if (/^\s*(select|with|pragma)|\breturning\b/i.test(this.sql)) {
      return { rows: statement.all(...this.params) as Record<string, unknown>[], changes: 0 };
    }
    const result = statement.run(...this.params);
    return { rows: [] as Record<string, unknown>[], changes: Number(result.changes) };
  }

  async all() {
    const { rows, changes } = timed(() => this.execute());
    return { results: rows, success: true, meta: { changes } };
  }

  async run() {
    return this.all();
  }

  async first(column?: string) {
    const { rows } = timed(() => this.execute());
    const row = rows[0] ?? null;
    return column === undefined ? row : (row?.[column] ?? null);
  }

  async raw() {
    const { rows } = timed(() => this.execute());
    return rows.map((row) => Object.values(row));
  }
}

function fakeD1(db: DatabaseSync): D1Database {
  const binding = {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.all());
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };

  return binding as unknown as D1Database;
}

/** An in-memory database with every migration applied, and its D1 binding. */
export function migratedD1(): { readonly sqlite: DatabaseSync; readonly DB: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(new URL(file, MIGRATIONS), "utf8").split(
      "--> statement-breakpoint",
    )) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }

  return { sqlite, DB: fakeD1(sqlite) };
}

/* ------------------------------------------------------------ requests -- */

let address = 0;

/**
 * A request to the console's API from `origin`, from a client address of
 * its own, so no rate limit is shared between runs: a GET, or a JSON POST
 * when `body` is given.
 */
export function apiRequest(
  origin: string,
  path: string,
  init: { body?: unknown; cookie?: string } = {},
): Request {
  address++;
  const headers = new Headers({
    origin,
    "cf-connecting-ip": `10.${(address >> 16) & 255}.${(address >> 8) & 255}.${address & 255}`,
  });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);

  return new Request(`${origin}${path}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** The cookies a response sets, as a `Cookie` header sends them back. */
export function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** Fails the bench when a request is not answered as it should be. */
export async function expecting(status: number, response: Promise<Response>): Promise<void> {
  const answered = await response;
  if (answered.status !== status) {
    throw new Error(`${answered.url} answered ${answered.status}, not ${status}`);
  }
}

/* ------------------------------------------------------- measurement -- */

interface Sample {
  /** Wall time, less the stand-in's. */
  readonly js: number;
  /**
   * The process's CPU time (every thread: the main one, and the pool that
   * Node's `crypto.subtle` runs on), less the stand-in's, which runs on the
   * main thread and so costs as much CPU as wall time. Microsecond-grained,
   * and it carries GC's threads too.
   */
  readonly cpu: number;
  readonly statements: number;
}

async function sample(work: () => Promise<unknown>): Promise<Sample> {
  const d1Before = d1Ms;
  const statementsBefore = d1Statements;
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  await work();
  const wall = performance.now() - start;
  const { user, system } = process.cpuUsage(cpuBefore);
  const d1 = d1Ms - d1Before;
  return {
    js: wall - d1,
    cpu: (user + system) / 1000 - d1,
    statements: d1Statements - statementsBefore,
  };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const results: Record<string, string | number>[] = [];

/**
 * Times `n` runs of what `prepare` returns, after a warm-up; `prepare` itself
 * (a sign-in to sign out, say) is not timed.
 */
export async function bench(
  label: string,
  n: number,
  prepare: () => Promise<() => Promise<unknown>>,
): Promise<void> {
  const samples: Sample[] = [];
  for (let index = 0; index < n + WARM_UP; index++) {
    const measured = await sample(await prepare());
    if (index >= WARM_UP) samples.push(measured);
  }
  const js = samples.map((s) => s.js);
  const cpu = samples.map((s) => s.cpu);
  results.push({
    operation: label,
    n,
    "p50 ms": percentile(js, 50).toFixed(2),
    "p95 ms": percentile(js, 95).toFixed(2),
    "CPU p50 ms": percentile(cpu, 50).toFixed(2),
    "D1 stmts": samples[0]?.statements ?? 0,
  });
}

/** Prints the Node version and every bench's row. */
export function report(): void {
  console.log(`node ${process.version}, ${process.arch}`);
  console.table(results);
}
