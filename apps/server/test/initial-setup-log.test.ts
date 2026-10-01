import { consoleAccount, consoleUser, property, subsonicUser } from "@stratosonic/db";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { GUEST_ROLE, seedConsoleUser } from "./console-auth-support";
import { seedUser, testEnv } from "./support";

/**
 * What the first run logs for each way a deployment can be configured (#97,
 * #99): a line when the console has no owner and nothing can create one, a
 * line when there is no Subsonic user and the deprecated INITIAL_* bootstrap
 * is not in use, and a warning when that bootstrap is half configured.
 *
 * This file owns its database, so it makes no requests: a request would
 * bootstrap `admin` from the test bindings before any test could look at an
 * empty database. The "logged once per isolate" markers live in the modules,
 * so each test imports them afresh, as a new isolate would, and no test
 * depends on another having run before it.
 */

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const NO_OWNER =
  "no owner exists: set SETUP_TOKEN (wrangler secret put SETUP_TOKEN) to create one in the console";

const NO_SUBSONIC_USER =
  "no Subsonic user exists: create one in the console (Subsonic users), or set INITIAL_USER and INITIAL_PASSWORD (deprecated)";

/**
 * The recommended configuration: `INITIAL_USER` is still there, as the plain
 * var wrangler.jsonc always carries, but there is no `INITIAL_PASSWORD`.
 */
function recommended(overrides: Partial<Env> = {}): Env {
  return { ...testEnv, INITIAL_PASSWORD: undefined, SETUP_TOKEN: undefined, ...overrides };
}

/**
 * The test bindings, which have everything the Subsonic bootstrap needs,
 * without `names`, and with a usable `SETUP_TOKEN`, so that only the
 * bootstrap has anything to say.
 */
function without(...names: (keyof Env)[]): Env {
  const env: Record<string, unknown> = { ...testEnv, SETUP_TOKEN: TOKEN };
  for (const name of names) delete env[name];

  return env as unknown as Env;
}

/** `runInitialSetup` from a fresh module registry: an isolate's first run. */
async function inFreshIsolate() {
  vi.resetModules();
  return (await import("../src/setup/initial-setup")).runInitialSetup;
}

let log: MockInstance<typeof console.log>;
let warn: MockInstance<typeof console.warn>;

/** Every line logged at any level, as the first argument of each call. */
function lines(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

/** The lines about the console's owner, leaving the Subsonic user's out. */
function ownerLines(): string[] {
  return lines(log).filter((line) => line !== NO_SUBSONIC_USER);
}

beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Back to an empty database, flag and all, for the next test.
  const db = database(testEnv);
  await db.delete(consoleAccount);
  await db.delete(consoleUser);
  await db.delete(subsonicUser);
  await db.delete(property);
});

describe("when no owner exists", () => {
  it("logs nothing when a usable SETUP_TOKEN can create one in the console", async () => {
    const runInitialSetup = await inFreshIsolate();

    await runInitialSetup(recommended({ SETUP_TOKEN: TOKEN }));

    expect(ownerLines()).toEqual([]);
    expect(lines(warn)).toEqual([]);
  });

  it("says once per isolate that no owner exists when there is no SETUP_TOKEN", async () => {
    const runInitialSetup = await inFreshIsolate();

    await runInitialSetup(recommended());
    await runInitialSetup(recommended());

    expect(ownerLines()).toEqual([NO_OWNER]);
    expect(lines(warn)).toEqual([]);
    expect(await database(testEnv).select().from(subsonicUser)).toHaveLength(0);
  });

  it("says so again in the next isolate", async () => {
    await (await inFreshIsolate())(recommended());
    await (await inFreshIsolate())(recommended());

    expect(ownerLines()).toEqual([NO_OWNER, NO_OWNER]);
  });

  it("says so whatever Subsonic users exist, since they cannot sign in to the console", async () => {
    await seedUser("admin", "sesame", true);
    const runInitialSetup = await inFreshIsolate();

    await runInitialSetup(recommended());

    expect(ownerLines()).toEqual([NO_OWNER]);
  });

  it("says so while console users exist but none is the owner", async () => {
    await seedConsoleUser("guest", "pw", GUEST_ROLE);

    await (await inFreshIsolate())(recommended());

    expect(ownerLines()).toEqual([NO_OWNER]);
  });

  it("treats a SETUP_TOKEN too short to use as no token", async () => {
    const runInitialSetup = await inFreshIsolate();

    await runInitialSetup(recommended({ SETUP_TOKEN: TOKEN.slice(0, 31) }));

    // The short token is reported on its own by setup-token.ts.
    expect(ownerLines()).toEqual([NO_OWNER]);
    expect(lines(warn)).toEqual([
      "setup: SETUP_TOKEN is shorter than 32 characters and is ignored",
    ]);
  });
});

describe("once the owner exists", () => {
  it("logs nothing, with or without a SETUP_TOKEN", async () => {
    await seedConsoleUser("owner", "pw");

    await (await inFreshIsolate())(recommended());
    await (await inFreshIsolate())(recommended({ SETUP_TOKEN: TOKEN }));

    expect(ownerLines()).toEqual([]);
    expect(lines(warn)).toEqual([]);
  });
});

describe("when no Subsonic user exists and INITIAL_PASSWORD is unset", () => {
  it("says so once per isolate, and again in the next", async () => {
    const runInitialSetup = await inFreshIsolate();

    await runInitialSetup(recommended({ SETUP_TOKEN: TOKEN }));
    await runInitialSetup(recommended({ SETUP_TOKEN: TOKEN }));
    await (await inFreshIsolate())(recommended({ SETUP_TOKEN: TOKEN }));

    expect(lines(log)).toEqual([NO_SUBSONIC_USER, NO_SUBSONIC_USER]);
    expect(lines(warn)).toEqual([]);
  });

  it("says nothing once a Subsonic user exists", async () => {
    await seedUser("admin", "sesame", true);

    await (await inFreshIsolate())(recommended({ SETUP_TOKEN: TOKEN }));

    expect(lines(log)).toEqual([]);
  });

  it("says nothing of it when INITIAL_PASSWORD is set", async () => {
    await (await inFreshIsolate())(without("INITIAL_USER"));

    expect(lines(log)).toEqual([]);
  });
});

describe("with INITIAL_PASSWORD but not what else the Subsonic bootstrap needs", () => {
  it("warns that INITIAL_USER is missing", async () => {
    await (await inFreshIsolate())(without("INITIAL_USER"));

    expect(lines(warn)).toEqual([
      "no initial Subsonic user created: INITIAL_PASSWORD is set but INITIAL_USER is not",
    ]);
    expect(lines(log)).toEqual([]);
  });

  it("warns that PASSWORD_ENCRYPTION_KEY is missing", async () => {
    await (await inFreshIsolate())(without("PASSWORD_ENCRYPTION_KEY"));

    expect(lines(warn)).toEqual([
      "no initial Subsonic user created: INITIAL_PASSWORD is set but PASSWORD_ENCRYPTION_KEY is not",
    ]);
  });

  it("names both when both are missing", async () => {
    await (await inFreshIsolate())(without("INITIAL_USER", "PASSWORD_ENCRYPTION_KEY"));

    expect(lines(warn)).toEqual([
      "no initial Subsonic user created: INITIAL_PASSWORD is set but INITIAL_USER and PASSWORD_ENCRYPTION_KEY are not",
    ]);
  });
});

describe("with everything the Subsonic bootstrap needs", () => {
  it("creates the Subsonic admin, and no console user, and logs nothing", async () => {
    await (await inFreshIsolate())(without());

    expect(await database(testEnv).select().from(subsonicUser)).toMatchObject([
      { userName: "admin", isAdmin: true },
    ]);
    expect(await database(testEnv).select().from(consoleUser)).toEqual([]);
    expect(lines(log)).toEqual([]);
    expect(lines(warn)).toEqual([]);
  });
});
