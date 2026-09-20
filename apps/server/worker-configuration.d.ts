// Hand-written stand-in for `wrangler types`: the bindings and variables
// declared in wrangler.jsonc. `Cloudflare.Env` is merged across declarations,
// so tests add their own bindings in test/env.d.ts.
declare namespace Cloudflare {
  interface Env {
    /** The D1 database holding the library index and users. */
    DB: D1Database;
    /** The R2 bucket the music library lives in. */
    MUSIC: R2Bucket;
    /** Username of the admin account created on first run. */
    INITIAL_USER: string;
  }
}
