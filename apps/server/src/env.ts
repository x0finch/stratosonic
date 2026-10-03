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
   * rather than a var, so that wrangler.jsonc stays account-agnostic. The
   * console's uploads reuse it for the bucket's S3 endpoint,
   * `https://<CF_ACCOUNT_ID>.r2.cloudflarestorage.com` (files/config.ts).
   */
  readonly CF_ACCOUNT_ID?: string;
  /**
   * The Access Key ID of an R2 API token with Object Read & Write on the one
   * bucket `MUSIC` binds, which the console's uploads are presigned with
   * (#83, "Configuration"; storage/presign.ts). Optional: without it, its secret,
   * `CF_ACCOUNT_ID` and `R2_BUCKET_NAME`, uploads are not configured and
   * `POST /api/files/uploads` answers 503. It appears in each presigned URL
   * (`X-Amz-Credential`), as SigV4 requires; it names the key, and is not it.
   */
  readonly R2_ACCESS_KEY_ID?: string;
  /**
   * That token's Secret Access Key. It never leaves the Worker: no response,
   * URL or log line carries it.
   */
  readonly R2_SECRET_ACCESS_KEY?: string;
  /**
   * `"off"` makes the console's Files page read-only (#83, owner decision 2):
   * its write routes answer `403 {"error":"file_writes_disabled"}` and
   * `GET /api/files/config` reports `writes.enabled: false`
   * (files/config.ts). A plain var, set in wrangler.jsonc's `env.preview`,
   * which binds the production bucket; production leaves it unset, and any
   * other value means writes are on.
   */
  readonly FILE_WRITES?: string;
}
