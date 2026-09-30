import { consoleSession, consoleVerification, rateLimit } from "@stratosonic/db";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleAuth } from "../src/console-auth/auth";
import {
  LONGEST_RATE_LIMIT_WINDOW_MS,
  PRUNE_LIMIT,
  type PrunedRows,
  pruneExpiredAuthRows,
  RATE_LIMIT_RETENTION_MS,
} from "../src/console-auth/prune";
import { database } from "../src/db";
import type { Env } from "../src/env";
import worker from "../src/index";
import { ensureInitialSetup } from "../src/setup/initial-setup";
import { cost, countingD1, seedConsoleUser, shape } from "./console-auth-support";
import { BASE, encryptionKey, testEnv } from "./support";

/**
 * The cron's prune of the console's expired auth rows (#93): what it deletes,
 * what it keeps, what it costs, and that it never stands between the cron and
 * the scan driver's poke.
 *
 * D1 is shared by the tests in this file, so each starts from empty tables.
 */

/** The instant every test prunes as of. */
const NOW = 1_800_000_000_000;

const db = database(testEnv);
let owner: string;
let nextId = 0;

function id(prefix: string): string {
  nextId++;
  return `${prefix}-${nextId}`;
}

async function seedSessions(...expiresAt: number[]): Promise<void> {
  await db.insert(consoleSession).values(
    expiresAt.map((at) => {
      const sessionId = id("session");
      return {
        id: sessionId,
        token: `token-${sessionId}`,
        userId: owner,
        expiresAt: new Date(at),
        createdAt: new Date(at - 7 * 86_400_000),
        updatedAt: new Date(at - 7 * 86_400_000),
      };
    }),
  );
}

async function seedRateLimits(...lastRequest: number[]): Promise<void> {
  await db.insert(rateLimit).values(
    lastRequest.map((at) => {
      const rowId = id("rate-limit");
      return {
        id: rowId,
        key: `203.0.113.1|/sign-in/username|${rowId}`,
        count: 1,
        lastRequest: at,
      };
    }),
  );
}

async function seedVerifications(...expiresAt: number[]): Promise<void> {
  await db.insert(consoleVerification).values(
    expiresAt.map((at) => ({
      id: id("verification"),
      identifier: "reset-password",
      value: "value",
      expiresAt: new Date(at),
      createdAt: new Date(at - 3_600_000),
      updatedAt: new Date(at - 3_600_000),
    })),
  );
}

async function remaining() {
  const sessions = await db.select({ expiresAt: consoleSession.expiresAt }).from(consoleSession);
  const rateLimits = await db.select({ lastRequest: rateLimit.lastRequest }).from(rateLimit);
  const verifications = await db
    .select({ expiresAt: consoleVerification.expiresAt })
    .from(consoleVerification);

  return {
    session: sessions.map((row) => row.expiresAt.getTime()).sort((a, b) => a - b),
    rateLimit: rateLimits.map((row) => row.lastRequest).sort((a, b) => a - b),
    verification: verifications.map((row) => row.expiresAt.getTime()).sort((a, b) => a - b),
  };
}

const NOTHING: PrunedRows = { session: 0, rateLimit: 0, verification: 0 };

beforeAll(async () => {
  // The cron's bootstrap, done once here, so no test's D1 sees it.
  await ensureInitialSetup(testEnv);
  owner = await seedConsoleUser("prune-owner", "sesame");
});

beforeEach(async () => {
  await db.batch([db.delete(consoleSession), db.delete(rateLimit), db.delete(consoleVerification)]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ====================================================== what goes == */

describe("pruning the console's auth rows", () => {
  it("deletes the expired rows and keeps the live ones", async () => {
    await seedSessions(NOW - 86_400_000, NOW - 1, NOW, NOW + 86_400_000);
    await seedRateLimits(
      NOW - RATE_LIMIT_RETENTION_MS - 86_400_000,
      NOW - RATE_LIMIT_RETENTION_MS - 1,
      NOW - RATE_LIMIT_RETENTION_MS,
      // A window long over, but within the margin: kept.
      NOW - 2 * 60_000,
      NOW,
    );
    await seedVerifications(NOW - 1, NOW + 1);

    expect(await pruneExpiredAuthRows(db, NOW)).toEqual({
      session: 2,
      rateLimit: 2,
      verification: 1,
    });
    expect(await remaining()).toEqual({
      // A session is expired once `expires_at` has passed, as Better Auth
      // judges it: one expiring this very instant still counts.
      session: [NOW, NOW + 86_400_000],
      rateLimit: [NOW - RATE_LIMIT_RETENTION_MS, NOW - 2 * 60_000, NOW],
      verification: [NOW + 1],
    });
  });

  it("keeps a rate-limit row an hour past the longest window the console configures", async () => {
    const auth = await createConsoleAuth({
      db: testEnv.DB,
      passphrase: encryptionKey(),
      origin: BASE,
    });
    // Better Auth's own default window (10 s) and built-in rules (at most
    // 60 s) sit under the constant as well; its customRules are ours.
    const windows = Object.values(auth.options.rateLimit.customRules).flatMap((rule) =>
      rule ? [rule.window] : [],
    );

    expect(Math.max(...windows) * 1000).toBeLessThanOrEqual(LONGEST_RATE_LIMIT_WINDOW_MS);
    expect(RATE_LIMIT_RETENTION_MS).toBe(LONGEST_RATE_LIMIT_WINDOW_MS + 3_600_000);
  });

  it("costs one batch of three statements, and writes nothing when nothing expired", async () => {
    await seedSessions(NOW + 1);
    await seedRateLimits(NOW);
    await seedVerifications(NOW + 1);
    const d1 = countingD1(testEnv.DB);

    expect(await pruneExpiredAuthRows(database({ ...testEnv, DB: d1.binding }), NOW)).toEqual(
      NOTHING,
    );

    expect(d1.statements.map(shape)).toEqual([
      "delete session",
      "delete rate_limit",
      "delete verification",
    ]);
    expect(cost(d1.statements)).toMatchObject({ statements: 3, roundTrips: 1, rowsWritten: 0 });
  });

  it("writes as many rows as it deletes", async () => {
    await seedSessions(NOW - 1, NOW - 2);
    await seedRateLimits(0, 1, 2);
    await seedVerifications(NOW - 1);
    const d1 = countingD1(testEnv.DB);

    const pruned = await pruneExpiredAuthRows(database({ ...testEnv, DB: d1.binding }), NOW);

    expect(pruned).toEqual({ session: 2, rateLimit: 3, verification: 1 });
    // D1's own `rows_written`, which is what it bills.
    expect(d1.statements.map((statement) => statement.rowsWritten)).toEqual([2, 3, 1]);
  });

  it("deletes at most the limit from each table a run, and the rest on the next", async () => {
    await seedSessions(NOW - 1, NOW - 2, NOW - 3, NOW - 4, NOW - 5);
    await seedRateLimits(0, 1, 2, 3, 4);
    await seedVerifications(NOW - 1, NOW - 2, NOW - 3);

    expect(await pruneExpiredAuthRows(db, NOW, 2)).toEqual({
      session: 2,
      rateLimit: 2,
      verification: 2,
    });
    expect(await pruneExpiredAuthRows(db, NOW, 2)).toEqual({
      session: 2,
      rateLimit: 2,
      verification: 1,
    });
    expect(await pruneExpiredAuthRows(db, NOW, 2)).toEqual({
      session: 1,
      rateLimit: 1,
      verification: 0,
    });
    expect(await remaining()).toEqual({ session: [], rateLimit: [], verification: [] });
  });

  it(`deletes at most ${PRUNE_LIMIT} rows from a table by default`, async () => {
    // One more expired row than the bound, written by D1 itself.
    await testEnv.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO rate_limit (id, key, count, last_request) SELECT 'bulk-' || i, 'bulk-' || i, 1, 0 FROM n`,
    )
      .bind(PRUNE_LIMIT + 1)
      .run();

    expect(await pruneExpiredAuthRows(db, NOW)).toEqual({ ...NOTHING, rateLimit: PRUNE_LIMIT });
    expect((await remaining()).rateLimit).toHaveLength(1);
  });
});

/* ======================================================== the cron == */

/** A scan driver that records its pokes, in place of the real one. */
function stubDriver(env: Env) {
  const start = vi.fn(async (_scheduledTime: number) => "started" as const);
  const cronEnv = {
    ...env,
    SCAN_DRIVER: { idFromName: () => ({}), get: () => ({ start }) },
  } as unknown as Env;

  return { start, cronEnv };
}

function controllerAt(scheduledTime: number): ScheduledController {
  return {
    scheduledTime,
    cron: "*/15 * * * *",
    noRetry() {
      // A cron run that fails is not retried; the next one pokes again.
    },
  };
}

describe("the cron", () => {
  it("prunes as of its scheduled time, before the poke, and logs what it deleted", async () => {
    await seedSessions(NOW - 1, NOW + 1);
    await seedRateLimits(0, NOW);
    const d1 = countingD1(testEnv.DB);
    const { start, cronEnv } = stubDriver({ ...testEnv, DB: d1.binding });
    let statementsBeforePoke = -1;
    start.mockImplementation(async () => {
      statementsBeforePoke = d1.statements.length;
      return "started";
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await worker.scheduled(controllerAt(NOW), cronEnv);

    expect(start).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(statementsBeforePoke).toBe(3);
    expect(await remaining()).toEqual({ session: [NOW + 1], rateLimit: [NOW], verification: [] });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "scan driver: a pass has started; pruned 2 expired console auth rows (session 1, rate_limit 1, verification 0)",
    );
  });

  it("still pokes the driver when the prune fails", async () => {
    const failing = {
      ...testEnv.DB,
      prepare: (sql: string) => testEnv.DB.prepare(sql),
      batch: async () => {
        throw new Error("D1 is unavailable");
      },
    } as unknown as D1Database;
    const { start, cronEnv } = stubDriver({ ...testEnv, DB: failing });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await worker.scheduled(controllerAt(NOW), cronEnv);

    expect(start).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(error).toHaveBeenCalledExactlyOnceWith(
      "console auth: pruning expired rows failed; the next cron run tries again",
      expect.any(Error),
    );
    expect(log).toHaveBeenCalledExactlyOnceWith("scan driver: a pass has started");
  });

  it("reports the prune on the line of a poke that fails", async () => {
    const { start, cronEnv } = stubDriver(testEnv);
    start.mockRejectedValue(new Error("the driver is unreachable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await worker.scheduled(controllerAt(NOW), cronEnv);

    expect(error).toHaveBeenCalledExactlyOnceWith(
      "scan driver: the poke failed; the next cron run pokes again; pruned 0 expired console auth rows (session 0, rate_limit 0, verification 0)",
      expect.any(Error),
    );
  });
});
