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
   * Password of the admin user created on first run. Deprecated: the setup
   * token below creates the first admin without a password in the secrets.
   */
  readonly INITIAL_PASSWORD?: string;
  /**
   * The one-time token that creates the first admin in the console, or later
   * resets an admin's password (setup/setup-token.ts). At least 32 characters,
   * or it counts as unset; each value works once.
   */
  readonly SETUP_TOKEN?: string;
  /**
   * Passphrase the AES-GCM password-encryption key is derived from, and the
   * admin console's session secret too (console-auth/auth.ts). Without it
   * Subsonic logins fail and every `/api` route answers 503.
   */
  readonly PASSWORD_ENCRYPTION_KEY?: string;
}
