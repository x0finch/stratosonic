import { property, user } from "@stratosonic/db";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { runInitialSetup } from "../src/setup/initial-setup";
import { seedUser, testEnv } from "./support";

/**
 * What the first-run bootstrap logs for each way a deployment can be
 * configured (#97).
 *
 * This file owns its database and its isolate-level "no admin" marker, so it
 * makes no requests: a request would bootstrap `admin` from the test bindings
 * before any test could look at an empty database. The tests run in order, and
 * the one that reports the missing admin first is the one that asserts the
 * line appears once per isolate.
 */

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const NO_ADMIN =
  "no admin exists: set SETUP_TOKEN (wrangler secret put SETUP_TOKEN) to create one in the console";

/**
 * The recommended configuration: `INITIAL_USER` is still there, as the plain
 * var wrangler.jsonc always carries, but there is no `INITIAL_PASSWORD`.
 */
function recommended(overrides: Partial<Env> = {}): Env {
  return { ...testEnv, INITIAL_PASSWORD: undefined, SETUP_TOKEN: undefined, ...overrides };
}

/** The test bindings, which have everything the fallback needs, without `names`. */
function without(...names: (keyof Env)[]): Env {
  const env: Record<string, unknown> = { ...testEnv };
  for (const name of names) delete env[name];

  return env as unknown as Env;
}

let log: MockInstance<typeof console.log>;
let warn: MockInstance<typeof console.warn>;

/** Every line logged at any level, as the first argument of each call. */
function lines(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Back to an empty database, flag and all, for the next test.
  await database(testEnv).delete(user);
  await database(testEnv).delete(property);
});

describe("without INITIAL_PASSWORD", () => {
  it("logs nothing when a usable SETUP_TOKEN can create the admin in the console", async () => {
    await runInitialSetup(recommended({ SETUP_TOKEN: TOKEN }));

    expect(lines(log)).toEqual([]);
    expect(lines(warn)).toEqual([]);
  });

  it("logs nothing once a user exists", async () => {
    await seedUser("owner", "pw", true);

    await runInitialSetup(recommended());

    expect(lines(log)).toEqual([]);
    expect(lines(warn)).toEqual([]);
  });

  it("says once per isolate that no admin exists when there is no SETUP_TOKEN either", async () => {
    await runInitialSetup(recommended());
    await runInitialSetup(recommended());

    expect(lines(log)).toEqual([NO_ADMIN]);
    expect(lines(warn)).toEqual([]);
    expect(await database(testEnv).select().from(user)).toHaveLength(0);
  });

  it("treats a SETUP_TOKEN too short to use as no token, without repeating the line", async () => {
    await runInitialSetup(recommended({ SETUP_TOKEN: TOKEN.slice(0, 31) }));

    // The line was already logged by the test before, in this isolate; the
    // short token is reported on its own by setup-token.ts.
    expect(lines(log)).toEqual([]);
    expect(lines(warn)).toEqual([
      "setup: SETUP_TOKEN is shorter than 32 characters and is ignored",
    ]);
  });
});

describe("with INITIAL_PASSWORD but not what else it needs", () => {
  it("warns that INITIAL_USER is missing", async () => {
    await runInitialSetup(without("INITIAL_USER"));

    expect(lines(warn)).toEqual([
      "no initial user created: INITIAL_PASSWORD is set but INITIAL_USER is not",
    ]);
    expect(lines(log)).toEqual([]);
  });

  it("warns that PASSWORD_ENCRYPTION_KEY is missing", async () => {
    await runInitialSetup(without("PASSWORD_ENCRYPTION_KEY"));

    expect(lines(warn)).toEqual([
      "no initial user created: INITIAL_PASSWORD is set but PASSWORD_ENCRYPTION_KEY is not",
    ]);
  });

  it("names both when both are missing", async () => {
    await runInitialSetup(without("INITIAL_USER", "PASSWORD_ENCRYPTION_KEY"));

    expect(lines(warn)).toEqual([
      "no initial user created: INITIAL_PASSWORD is set but INITIAL_USER and PASSWORD_ENCRYPTION_KEY are not",
    ]);
  });
});

describe("with everything the fallback needs", () => {
  it("creates the admin and logs nothing", async () => {
    await runInitialSetup(testEnv);

    expect(await database(testEnv).select().from(user)).toHaveLength(1);
    expect(lines(log)).toEqual([]);
    expect(lines(warn)).toEqual([]);
  });
});
