/**
 * SPIKE #86 - CPU microbenchmark of the console auth code paths, in Node.
 *
 * Why Node: workerd does not advance `Date.now()` / `performance.now()` while
 * JavaScript runs (a Spectre mitigation), so CPU cannot be timed from inside
 * a Worker. This runs the very same modules - Better Auth, the Drizzle D1
 * driver, our hooks - over a D1 stand-in built on `node:sqlite`, and reports
 * the time spent outside that stand-in, which is the part a Worker is billed
 * for (D1 executes on its own machine; the Worker only waits on it).
 *
 *   node ../../node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs \
 *     scripts/bench-console-auth.ts
 */

import { scryptSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const importStart = performance.now();
const { createConsoleAuth, deriveAuthSecret } = await import("../src/console-auth/auth");
const { createUserWithCredential } = await import("../src/console-auth/credentials");
const { decryptPassword, encryptPassword } = await import("../src/auth/crypto");
const { drizzle } = await import("drizzle-orm/d1");
const importMs = performance.now() - importStart;

// --- a D1 stand-in on node:sqlite, timing every call it answers -------------

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
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as Param;
}

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: Param[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values.map(toParam));
  }

  private execute() {
    const statement = this.db.prepare(this.sql);
    const isQuery = /^\s*(select|with|pragma)|\breturning\b/i.test(this.sql);
    if (isQuery) {
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

function fakeD1(db: DatabaseSync) {
  return {
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
    async exec(sql: string) {
      timed(() => db.exec(sql));
    },
  } as unknown as D1Database;
}

// --- setup -------------------------------------------------------------------

const sqlite = new DatabaseSync(":memory:");
const migrationsDir = new URL("../../../packages/db/migrations/", import.meta.url);
for (const file of readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()) {
  const text = readFileSync(new URL(file, migrationsDir), "utf8");
  for (const statement of text.split("--> statement-breakpoint")) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

const KEY = "bench-password-encryption-key";
const ORIGIN = "https://stratosonic.bench";
const DB = fakeD1(sqlite);
const env = { DB, PASSWORD_ENCRYPTION_KEY: KEY } as unknown as Parameters<
  typeof createConsoleAuth
>[0];

await createUserWithCredential(drizzle(DB), KEY, {
  userName: "Alice",
  password: "wonderland",
  isAdmin: true,
});
const secret = await deriveAuthSecret(KEY);

let address = 0;
function request(path: string, init: { body?: unknown; cookie?: string } = {}) {
  address++;
  const headers = new Headers({
    origin: ORIGIN,
    "cf-connecting-ip": `10.${(address >> 16) & 255}.${(address >> 8) & 255}.${address & 255}`,
  });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

// --- measurement -----------------------------------------------------------

interface Sample {
  total: number;
  d1: number;
  statements: number;
}

async function sample(work: () => Promise<unknown>): Promise<Sample> {
  const d1Before = d1Ms;
  const statementsBefore = d1Statements;
  const start = performance.now();
  await work();
  const total = performance.now() - start;
  return { total, d1: d1Ms - d1Before, statements: d1Statements - statementsBefore };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const results: Record<string, unknown>[] = [];

async function bench(
  label: string,
  iterations: number,
  work: () => Promise<{ measure: () => Promise<unknown> }>,
) {
  const samples: Sample[] = [];
  for (let index = 0; index < iterations + 20; index++) {
    const { measure } = await work();
    const measured = await sample(measure);
    if (index >= 20) samples.push(measured); // warm-up discarded
  }
  const js = samples.map((s) => s.total - s.d1);
  results.push({
    operation: label,
    n: iterations,
    "js ms p50": percentile(js, 50).toFixed(3),
    "js ms p95": percentile(js, 95).toFixed(3),
    "js ms mean": (js.reduce((a, b) => a + b, 0) / js.length).toFixed(3),
    "sqlite ms mean": (samples.reduce((a, s) => a + s.d1, 0) / samples.length).toFixed(3),
    "D1 statements": samples[0]?.statements ?? 0,
  });
}

const auth = createConsoleAuth(env, { secret, baseURL: ORIGIN, quiet: true });
await auth.$context;

async function signIn() {
  const response = await auth.handler(
    request("/sign-in/username", { body: { username: "alice", password: "wonderland" } }),
  );
  if (response.status !== 200) throw new Error(`sign-in failed: ${response.status}`);
  return cookieHeader(response);
}

await bench("construct betterAuth() + await $context", 50, async () => ({
  measure: async () => {
    const instance = createConsoleAuth(env, { secret, baseURL: ORIGIN, quiet: true });
    await instance.$context;
  },
}));

await bench(
  "first request on a fresh instance (construct + get-session, no cookie)",
  50,
  async () => ({
    measure: async () => {
      const instance = createConsoleAuth(env, { secret, baseURL: ORIGIN, quiet: true });
      await instance.handler(request("/get-session"));
    },
  }),
);

await bench("sign-in (username, AES verify, limiter, session insert)", 300, async () => ({
  measure: signIn,
}));

await bench("sign-in, wrong password", 300, async () => ({
  measure: () =>
    auth.handler(request("/sign-in/username", { body: { username: "alice", password: "nope" } })),
}));

const cookie = await signIn();

await bench("get-session, cookie cache hit", 2000, async () => ({
  measure: () => auth.handler(request("/get-session", { cookie })),
}));

await bench(
  "auth.api.getSession({ headers }), cookie cache hit (in-Worker middleware)",
  2000,
  async () => ({
    measure: () => auth.api.getSession({ headers: new Headers({ cookie }) }),
  }),
);

const tokenOnly = cookie
  .split("; ")
  .filter((pair) => pair.includes("session_token"))
  .join("; ");
await bench("get-session, cache miss (session + user read, re-cache)", 1000, async () => ({
  measure: () => auth.handler(request("/get-session", { cookie: tokenOnly })),
}));

await bench("sign-out", 300, async () => {
  const signedIn = await signIn();
  return { measure: () => auth.handler(request("/sign-out", { body: {}, cookie: signedIn })) };
});

const stored = await encryptPassword(KEY, "wonderland");
await bench("AES-GCM decrypt alone (the verify hook's work)", 2000, async () => ({
  measure: () => decryptPassword(KEY, stored),
}));

await bench("HKDF secret derivation", 500, async () => ({
  measure: () => deriveAuthSecret(KEY),
}));

// Better Auth's default: scrypt N=16384 r=16 p=1 dkLen=64. workerd runs
// node:crypto's scrypt on the request thread, so it is timed synchronously.
const scryptTimes: number[] = [];
for (let index = 0; index < 6; index++) {
  const start = performance.now();
  scryptSync("wonderland", "0123456789abcdef0123456789abcdef", 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  });
  if (index > 0) scryptTimes.push(performance.now() - start);
}
results.push({
  operation: "default scrypt hash (what the hooks avoid)",
  n: scryptTimes.length,
  "js ms p50": percentile(scryptTimes, 50).toFixed(3),
  "js ms p95": percentile(scryptTimes, 95).toFixed(3),
  "js ms mean": (scryptTimes.reduce((a, b) => a + b, 0) / scryptTimes.length).toFixed(3),
  "sqlite ms mean": "-",
  "D1 statements": 0,
});

console.log(
  `node ${process.version}, ${process.arch}; module import of the auth stack: ${importMs.toFixed(1)} ms`,
);
console.table(results);
