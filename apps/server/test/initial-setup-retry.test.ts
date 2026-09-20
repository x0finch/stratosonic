import { user } from "@stratosonic/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { ensureInitialSetup } from "../src/setup/initial-setup";
import { testEnv } from "./support";

/**
 * This file owns its database and, just as importantly, its isolate-level
 * bootstrap marker: it asserts what happens when the *first* attempt fails, so
 * nothing here may have bootstrapped successfully first. That is why it makes
 * no requests — a request would bootstrap before the test could.
 */

/** An environment whose D1 binding fails the way an unavailable database does. */
const unavailableDatabase = {
  ...testEnv,
  DB: {
    prepare() {
      throw new Error("D1_ERROR: database is unavailable");
    },
  },
} as unknown as Env;

describe("a bootstrap that fails", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not fail the request that happened to be first", async () => {
    await expect(ensureInitialSetup(unavailableDatabase)).resolves.toBeUndefined();
  });

  it("is retried by the next request, with that request's own bindings", async () => {
    await ensureInitialSetup(unavailableDatabase);

    await ensureInitialSetup(testEnv);

    const created = await database(testEnv).select().from(user);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ userName: "admin", isAdmin: true });
  });

  it("stops retrying once an attempt has come through", async () => {
    await ensureInitialSetup(testEnv);

    // The marker is set, so an unusable database is never even asked.
    await expect(ensureInitialSetup(unavailableDatabase)).resolves.toBeUndefined();
    expect(await database(testEnv).select().from(user)).toHaveLength(1);
  });
});
