# @stratosonic/server

The Worker: the Subsonic API under `/rest`, the public image URLs under
`/share`, the admin console's JSON API under `/api`, and the cron and Durable
Object that scan the library. It also serves the console (`apps/admin`) as
static assets; see that package's README for how.

## Secrets

The Worker's secrets are set once per environment with `wrangler secret put`,
and never written to `wrangler.jsonc`. For `wrangler dev`, copy
`.dev.vars.example` to `.dev.vars` and fill it in.

- `PASSWORD_ENCRYPTION_KEY`: the passphrase every Subsonic password is
  encrypted under (ADR-0003), and the source of the console's session secret
  and of the pepper console passwords are hashed with (ADR-0007). Without it
  Subsonic logins fail and every `/api` route answers 503. Changing it after
  users exist locks everyone out.
- `SETUP_TOKEN`: a one-time token for creating the console's owner on first
  run, described below. It does nothing else.
- `CF_ANALYTICS_TOKEN` and `CF_ACCOUNT_ID` (optional): the console's
  free-tier usage panel, described below. Without both, the panel is hidden.

## Usage panel (optional)

The console's Overview can show today's free-tier usage for the whole
Cloudflare account (Worker requests, D1 rows, Durable Object requests and
duration, R2 operations and storage), read from Cloudflare's GraphQL
Analytics API. It needs two secrets:

1. In the Cloudflare dashboard, open **My Profile › API Tokens › Create
   Token**, and choose **Create Custom Token**.
2. Under **Permissions**, choose **Account**, **Account Analytics**,
   **Read**. Nothing else is needed.
3. Under **Account Resources**, choose **Include** and the one account the
   Worker runs in, then create the token.
4. Set it, and the account's id (the 32 hex characters shown as **Account
   ID** on the Workers & Pages overview, or in any dashboard URL):

   ```sh
   wrangler secret put CF_ANALYTICS_TOKEN
   wrangler secret put CF_ACCOUNT_ID
   ```

The token stays on the server: the console is sent only numbers. Each
refresh is two GraphQL requests (one, if the first fails): every figure but
one, then the Durable Objects' active time, which no Cloudflare page documents
and so is asked for on its own. If that second request fails, only the
duration is left blank, and the Worker logs it once per isolate. A refresh is
cached in the isolate for 5 minutes, so the panel costs no D1 and at most two
Cloudflare API calls per 5 minutes per isolate. With the token set but not the
account id, the Worker logs a warning once per isolate and the panel stays
hidden.

A token Cloudflare refuses makes `GET /api/usage` answer
`502 {"error":"analytics_unavailable","reason":"unauthorized"}`. So does a
dataset the account cannot query (Cloudflare answers "does not have access to
the path"), which fails the whole request: the Worker's log line gives the
error's path (for example `viewer/accounts/0/r2Storage`), which tells the two
apart.

## Files: browsing and deleting

The console's Files page manages the bound bucket (`MUSIC`) as folders,
through `/api/files`. It needs no configuration to browse and delete:

- `GET /api/files?prefix=` lists one folder, a page of 1,000 entries at a
  time. The scanner's `_covers/` prefix is hidden, and every write under it
  is refused. A `cursor` R2 refuses answers `400 {"error":"invalid_cursor"}`.
- `POST /api/files/delete` (up to 250 keys) and
  `POST /api/files/delete-folder` (2,000 keys a call, called again until
  `done`) delete objects. **Deletes are permanent**: there is no trash and no
  undo. Tracks leave the library at the scan that follows the change;
  playlists leave at once. Each answer that deleted something carries
  `scan`: `{"scheduledAt": "<ISO 8601>", "afterCurrentPass": false}`,
  `{"scheduledAt": null, "afterCurrentPass": true}`, or `null` when the scan
  driver could not be told (the next cron pass indexes the change). A
  delete-folder call that found nothing left to delete answers
  `{"deleted": 0, "done": true}`, with no `scan`.

**Preview is read-only for files.** The preview environment binds the
production bucket, so `wrangler.jsonc` sets the var `FILE_WRITES = "off"` in
`env.preview.vars`. With it, every Files route that writes answers
`403 {"error":"file_writes_disabled"}`, and `GET /api/files/config` reports
`"writes": {"enabled": false}`, so the console hides its write controls.
Production leaves `FILE_WRITES` unset. The value is read ignoring case and
surrounding spaces (`OFF` and ` off ` are off too); any other value, or none,
leaves writes on.

## Console users and Subsonic users

The console has users of its own, **console users**, which are separate from
**Subsonic users**:

- a console user signs in to the console and never to Subsonic (a Subsonic
  client given a console user's name and password gets error 40);
- a Subsonic user signs in to Subsonic and never to the console;
- changing a console password changes no Subsonic password.

"Admin" means only the Subsonic role. A console user is named by their role
instead: the only one for now is **owner**, who can do all the console does,
and there is at most one. Console passwords are stored as a peppered
HMAC-SHA256, one way, while Subsonic passwords stay reversibly encrypted,
because Subsonic's token auth needs them back (ADR-0003, ADR-0007).

The console's users live in Better Auth's standard tables (`user`,
`session`, `account`, `verification`); the Subsonic users, in Navidrome's
shape, live in `subsonic_user`. Subsonic users are managed in the console's
**Subsonic users** page (`/api/subsonic-users`, #82), and the first one can
also come from `INITIAL_USER` / `INITIAL_PASSWORD` (deprecated, below). The
first Subsonic user must be a Subsonic admin, and the last Subsonic admin can
be neither demoted nor deleted. Deleting a Subsonic user deletes their
stars, ratings, play counts, bookmarks, play queue and playlists, including
the playlists' `.m3u` files in the bucket.

## First run

On a fresh deployment, generate a setup token, set it, and open the console:

```sh
openssl rand -hex 32              # prints the token; keep it for the next steps
wrangler secret put SETUP_TOKEN   # paste it when asked
```

`/setup` in the console asks for the token, with the owner's name and
password. It works only while there is no console user, whatever Subsonic
users there are, and only once. The token must be at least 32 characters; a
shorter value is ignored (the Worker logs that it is) and setup stays closed.
While there is no owner and no usable token is set, the Worker logs `no owner
exists: set SETUP_TOKEN (wrangler secret put SETUP_TOKEN) to create one in
the console` once per isolate.

`SETUP_TOKEN` is used once, at first run: setup records the value as spent,
and a spent value can never set the server up again. Deleting the secret
afterwards (`wrangler secret delete SETUP_TOKEN`) is optional; leaving it set
has no effect. It is not a way to reset a password.

The route behind `/setup` is `POST /api/setup`, which takes `{"token",
"username", "password"}` as JSON. Like every write under `/api`, it refuses a
request whose `Origin` is not the Worker's own, so a script calling it has to
send it:

```sh
curl https://<worker>/api/setup \
  -H 'Origin: https://<worker>' -H 'Content-Type: application/json' \
  -d '{"token":"...","username":"owner","password":"..."}'
```

## Upgrading a deployed server to the console's own users

The release that brings console users (#99) ships migration 0008, which
renames the Subsonic `user` table to `subsonic_user`, with every row and
foreign key, and creates the console's tables under Better Auth's names. The
deploy workflow applies the migration and then deploys the Worker, so:

- Between the two steps, the Worker still running is the old one, which reads
  and writes Subsonic users' rows in `user` and now finds Better Auth's table
  there: its queries fail with `no such column`, so every `/rest` request in
  that short window answers Subsonic error 0 (a generic error), not 40. Writes
  clients attempt in the window (scrobbles, stars and ratings,
  `savePlayQueue`, bookmarks) are not recorded; nothing already stored is
  affected, and clients work again once the new code is live.
- If the release has to be undone, D1 Time Travel restores the database to
  its state before the migration (`wrangler d1 time-travel restore
  stratosonic_db --timestamp=<an RFC 3339 time before the deploy>`), and the
  previous Worker version can be rolled back to (`wrangler rollback`).
- After the first deploy, set `SETUP_TOKEN` as above and create the owner at
  `/setup`.
- The existing Subsonic admin, and every other Subsonic user, keeps working
  with the same name and password; they are Subsonic users, not console users,
  and cannot sign in to the console.

## Lost owner password (last resort)

The owner changes their password at `/account` while they can sign in. The
console has no password reset: if the owner's password is lost, the owner is
deleted and the server set up again. This needs Cloudflare access to the
account the Worker runs in.

1. Count what the delete touches, and note the `subsonic_users` number:

   ```sh
   wrangler d1 execute stratosonic_db --remote \
     --command "SELECT (SELECT count(*) FROM user) AS console_users, (SELECT count(*) FROM session) AS sessions, (SELECT count(*) FROM account) AS accounts, (SELECT count(*) FROM subsonic_user) AS subsonic_users"
   ```

2. Delete the owner's row. The owner's sessions and credential account are
   deleted with it (their foreign keys cascade):

   ```sh
   wrangler d1 execute stratosonic_db --remote \
     --command "DELETE FROM user WHERE role = 'owner'"
   ```

   Setup reopens only when no console user is left at all. Today the owner
   is the only console user, so this one row is enough; once there are
   others, they have to be deleted too (`DELETE FROM user`).

3. Wrangler only reports that the delete ran, so run the same `SELECT` as in
   step 1 again and compare. `console_users`, `sessions` and `accounts` must
   all be `0` now: no console user is left for setup to wait on, and the
   cascade took the owner's sessions and credential account with it.
   `subsonic_users` must be the number noted in step 1: the delete leaves
   Subsonic users alone.

   A browser still signed in as the deleted owner may go on reading
   `/api/me` for up to the 5-minute session cookie cache; every write is
   refused at once.

4. Set a **new** `SETUP_TOKEN` (the value used before is spent and stays
   refused) and set the server up again at `/setup`, as on first run:

   ```sh
   openssl rand -hex 32
   wrangler secret put SETUP_TOKEN
   ```

5. Subsonic users, the library and playlists are unaffected: `user` holds
   console users only, and Subsonic users live in `subsonic_user`.

## Deprecated: `INITIAL_USER` / `INITIAL_PASSWORD`

The first Subsonic user, a Subsonic admin, comes from the `INITIAL_USER` var in
`wrangler.jsonc` and an `INITIAL_PASSWORD` secret, created on the first request
while the Subsonic user table is empty. It is a Subsonic user only: it cannot
sign in to the console. They keep working in this release, beside the
console, which creates Subsonic users too (#82), but they keep a password in
the Worker's secrets: delete `INITIAL_PASSWORD` once the user exists
(`wrangler secret delete INITIAL_PASSWORD`). With `INITIAL_PASSWORD` set
but `INITIAL_USER` or `PASSWORD_ENCRYPTION_KEY` missing, the Worker warns that
no initial Subsonic user was created; with no Subsonic user and
`INITIAL_PASSWORD` unset, it logs `no Subsonic user exists: create one in the
console (Subsonic users), or set INITIAL_USER and INITIAL_PASSWORD
(deprecated)` once per isolate.

## Scripts

Run from the repository root with `pnpm --filter @stratosonic/server <script>`:

- `dev` builds the console and starts `wrangler dev`.
- `test` runs the Workers-pool tests, then the routing tests.
- `typecheck` regenerates the binding types and type-checks.
- `bench:console-auth` and `bench:startup` measure the console's CPU and the
  Worker's startup cost; see the scripts for how to read them.
