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
- `SETUP_TOKEN`: a one-time token for creating the console's owner and
  recovering a console password, described below.

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
shape, live in `subsonic_user`. Subsonic users come from `INITIAL_USER` /
`INITIAL_PASSWORD` (deprecated, below) for now, and from the console once it
manages them (#82).

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

## Recovering the owner

If the owner's password is forgotten, set a **new** token value (a value that
has been used once is refused from then on) and open `/setup/reset`:

```sh
openssl rand -hex 32
wrangler secret put SETUP_TOKEN
```

The reset asks for the token, the owner's name and a new password, and ends
every console session of the owner; the role stays as it is. It cannot reset a
Subsonic user's password.

The routes behind these pages are `POST /api/setup` and
`POST /api/setup/reset`, which take `{"token", "username", "password"}` as
JSON. Like every write under `/api`, they refuse a request whose `Origin` is not
the Worker's own, so a script calling them has to send it:

```sh
curl https://<worker>/api/setup/reset \
  -H 'Origin: https://<worker>' -H 'Content-Type: application/json' \
  -d '{"token":"...","username":"owner","password":"..."}'
```

## Deprecated: `INITIAL_USER` / `INITIAL_PASSWORD`

The first Subsonic user, a Subsonic admin, comes from the `INITIAL_USER` var in
`wrangler.jsonc` and an `INITIAL_PASSWORD` secret, created on the first request
while the Subsonic user table is empty. It is a Subsonic user only: it cannot
sign in to the console. They keep working in this release, and are how a
Subsonic user is created until the console manages them (#82), but they keep a
password in the Worker's secrets: delete `INITIAL_PASSWORD` once the user
exists (`wrangler secret delete INITIAL_PASSWORD`). With `INITIAL_PASSWORD` set
but `INITIAL_USER` or `PASSWORD_ENCRYPTION_KEY` missing, the Worker warns that
no initial Subsonic user was created; with no Subsonic user and
`INITIAL_PASSWORD` unset, it logs `no Subsonic user exists: set INITIAL_USER
and INITIAL_PASSWORD to create one (the console will manage Subsonic users in
a later release)` once per isolate.

## Scripts

Run from the repository root with `pnpm --filter @stratosonic/server <script>`:

- `dev` builds the console and starts `wrangler dev`.
- `test` runs the Workers-pool tests, then the routing tests.
- `typecheck` regenerates the binding types and type-checks.
- `bench:console-auth` and `bench:startup` measure the console's CPU and the
  Worker's startup cost; see the scripts for how to read them.
