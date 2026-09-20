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
  /** Password of the admin user created on first run. */
  readonly INITIAL_PASSWORD?: string;
  /** Passphrase the AES-GCM password-encryption key is derived from. */
  readonly PASSWORD_ENCRYPTION_KEY?: string;
}
