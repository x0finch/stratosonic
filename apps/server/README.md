# @stratosonic/server

The Worker: the Subsonic API under `/rest`, the public image URLs under
`/share`, the admin console's JSON API under `/api`, and the cron and Durable
Object that scan the library. It also serves the console (`apps/admin`) as
static assets; see that package's README for how.

## Secrets

The Worker's secrets are set once per environment with `wrangler secret put`,
and never written to `wrangler.jsonc`. For `wrangler dev`, copy
`.dev.vars.example` to `.dev.vars` and fill it in.

- `PASSWORD_ENCRYPTION_KEY`: the passphrase every stored password is
  encrypted under (ADR-0003), and the console's session secret. Without it
  Subsonic logins fail and every `/api` route answers 503. Changing it after
  users exist locks everyone out.
- `SETUP_TOKEN`: a one-time token for setting up and recovering the admin,
  described below.

## First run

On a fresh deployment, generate a setup token, set it, and open the console:

```sh
openssl rand -hex 32              # prints the token; keep it for the next steps
wrangler secret put SETUP_TOKEN   # paste it when asked
```

`/setup` in the console asks for the token, with the admin's name and
password. It works only while there are no users, and only once. The token
must be at least 32 characters; a shorter value is ignored (the Worker logs
that it is) and setup stays closed.

## Recovering the admin

If the admin's password is forgotten, set a **new** token value (a value that
has been used once is refused from then on) and open `/setup/reset`:

```sh
openssl rand -hex 32
wrangler secret put SETUP_TOKEN
```

The reset asks for the token, the admin's name and a new password. It ends
every console session of that admin, and their Subsonic clients need the new
password too. Only an admin's password can be reset this way.

The routes behind these pages are `POST /api/setup` and
`POST /api/setup/reset`, which take `{"token", "username", "password"}` as
JSON. Like every write under `/api`, they refuse a request whose `Origin` is not
the Worker's own, so a script calling them has to send it:

```sh
curl https://<worker>/api/setup/reset \
  -H 'Origin: https://<worker>' -H 'Content-Type: application/json' \
  -d '{"token":"...","username":"admin","password":"..."}'
```

## Deprecated: `INITIAL_USER` / `INITIAL_PASSWORD`

Before the setup token, the first admin came from the `INITIAL_USER` var in
`wrangler.jsonc` and an `INITIAL_PASSWORD` secret, created on the first request
while the user table is empty. They still work in this release, but they keep a
password in the Worker's secrets; use `SETUP_TOKEN` instead, and delete
`INITIAL_PASSWORD` once the admin exists (`wrangler secret delete
INITIAL_PASSWORD`).

## Scripts

Run from the repository root with `pnpm --filter @stratosonic/server <script>`:

- `dev` builds the console and starts `wrangler dev`.
- `test` runs the Workers-pool tests, then the routing tests.
- `typecheck` regenerates the binding types and type-checks.
- `bench:console-auth` and `bench:startup` measure the console's CPU and the
  Worker's startup cost; see the scripts for how to read them.
