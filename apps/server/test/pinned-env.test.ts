import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { configuredSetupToken } from "../src/setup/setup-token";
import { PINNED_ENV } from "./pinned-env";
import { testEnv } from "./support";

/**
 * The Worker under test sees the pinned secrets and vars, and nothing from a
 * developer's local `.dev.vars` (#109). That the list covers every key `Env`
 * declares is checked by the typecheck, in test/pinned-env.ts; this checks the
 * pool really gives the Worker those values, which a `.dev.vars` loaded
 * through wrangler.jsonc would otherwise override.
 */
describe("the test bindings", () => {
  it.each(Object.entries(PINNED_ENV))("pin %s", (key, value) => {
    expect((env as unknown as Record<string, unknown>)[key]).toBe(value);
  });

  it("leave the setup token unset, as in CI", () => {
    expect(configuredSetupToken(testEnv)).toBeNull();
  });
});
