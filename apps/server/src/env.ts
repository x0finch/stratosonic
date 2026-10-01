/**
 * The Worker's environment.
 *
 * `Cloudflare.Env` is generated from wrangler.jsonc by `wrangler types`, which
 * only knows the bindings and plain vars declared there. Worker secrets are set
 * with `wrangler secret put` and deliberately never appear in the config file,
 * so they are declared here instead.
 *
 * They are optional because a Worker can be deployed — or a test can run —
 * before a secret is set. Code that needs one has to say what happens when it
 * is missing, rather than trusting a type that cannot be enforced at runtime.
 */
export interface Env extends Cloudflare.Env {
  /**
   * Password of the Subsonic admin user created on first run. Deprecated: it
   * keeps a password in the secrets, and the console will create Subsonic
   * users (#82).
   */
  readonly INITIAL_PASSWORD?: string;
  /**
   * The one-time token that creates the console's owner on first run, and
   * does nothing else (setup/setup-token.ts). At least 32 characters, or it
   * counts as unset; each value works once.
   */
  readonly SETUP_TOKEN?: string;
  /**
   * Passphrase the AES-GCM password-encryption key is derived from, and the
   * admin console's session secret and the pepper of its users' passwords too
   * (console-auth/auth.ts, console-auth/password-hash.ts). Without it
   * Subsonic logins fail and every `/api` route answers 503.
   */
  readonly PASSWORD_ENCRYPTION_KEY?: string;
  /**
   * A Cloudflare API token with Account › Account Analytics › Read, for the
   * console's free-tier usage panel (usage/analytics.ts, #82). Optional:
   * without it, or without `CF_ACCOUNT_ID`, the panel is not configured. It
   * is only ever sent to Cloudflare's GraphQL API, never to a client or a log.
   */
  readonly CF_ANALYTICS_TOKEN?: string;
  /**
   * The account tag the usage panel reads, which no binding exposes. A secret
   * rather than a var, so that wrangler.jsonc stays account-agnostic.
   */
  readonly CF_ACCOUNT_ID?: string;
}
