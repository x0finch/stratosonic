// With its extension, as vitest.config.ts imports this file (see there).
import type { Env } from "../src/env.ts";

/**
 * The value every test starts from for each of the Worker's secrets and plain
 * vars (#109).
 *
 * Both test harnesses read wrangler.jsonc the way `wrangler dev` does, so they
 * also load a developer's local `.dev.vars` (or `.env`), and any key they are
 * not given explicitly takes its value from there: a local `SETUP_TOKEN` once
 * made the bootstrap skip its owner check and failed a test that CI, with no
 * such file, passed. vitest.config.ts binds all of these, and the routing tests
 * pass them as the harness's secrets, so a local file can never change a
 * result. A test that needs another value overrides it on top.
 *
 * `satisfies` keeps the list complete: a secret added to `Env` (src/env.ts),
 * or a var added to wrangler.jsonc, that is not pinned here fails the
 * typecheck. test/pinned-env.test.ts checks the values reach the Worker.
 */
export const PINNED_ENV = {
  // Deprecated, like the first-run Subsonic admin they create.
  INITIAL_USER: "admin",
  INITIAL_PASSWORD: "sesame",
  PASSWORD_ENCRYPTION_KEY: "test-password-encryption-key",
  // Empty counts as unset (`configuredSetupToken`), as it does in CI.
  SETUP_TOKEN: "",
  // Empty counts as unset: the usage panel is not configured, and nothing
  // calls Cloudflare's API.
  CF_ANALYTICS_TOKEN: "",
  CF_ACCOUNT_ID: "",
} as const satisfies Record<StringEnvKey, string>;

/**
 * The keys of `Env` that hold a string: the secrets declared in src/env.ts and
 * the vars `wrangler types` generates from wrangler.jsonc, which is exactly
 * what `.dev.vars` can set. Bindings such as `DB` are objects, and left out.
 */
export type StringEnvKey = {
  [K in keyof Env]-?: NonNullable<Env[K]> extends string ? K : never;
}[keyof Env];
