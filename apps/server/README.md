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
  and of the pepper its operators' passwords are hashed with (ADR-0007).
  Without it Subsonic logins fail and every `/api` route answers 503.
  Changing it after users exist locks everyone out.
- `SETUP_TOKEN`: a one-time token for creating and recovering the console's
  operators, described below.

## Operators and Subsonic users

The console has accounts of its own, **operators**, which are separate from
Subsonic users:

- an operator signs in to the console and never to Subsonic (a Subsonic
  client given an operator's name and password gets error 40);
- a Subsonic user signs in to Subsonic and never to the console;
- changing an operator's password changes no Subsonic password.

Operators have no roles: each can do all the console does. Their passwords
are stored as a peppered HMAC-SHA256, one way, while Subsonic passwords stay
reversibly encrypted, because Subsonic's token auth needs them back
(ADR-0003, ADR-0007).

Subsonic users come from `INITIAL_USER` / `INITIAL_PASSWORD` (deprecated,
below) for now, and from the console once it manages them (#82).

## First run

On a fresh deployment, generate a setup token, set it, and open the console:

```sh
openssl rand -hex 32              # prints the token; keep it for the next steps
wrangler secret put SETUP_TOKEN   # paste it when asked
```

`/setup` in the console asks for the token, with the operator's name and
password. It works only while there is no operator, whatever Subsonic users
there are, and only once. The token must be at least 32 characters; a
shorter value is ignored (the Worker logs that it is) and setup stays closed.
Until an operator exists and while no usable token is set, the Worker logs
`no operator exists: set SETUP_TOKEN (wrangler secret put SETUP_TOKEN) to
create one in the console` once per isolate.

## Recovering an operator

If an operator's password is forgotten, set a **new** token value (a value
that has been used once is refused from then on) and open `/setup/reset`:

```sh
openssl rand -hex 32
wrangler secret put SETUP_TOKEN
```

The reset asks for the token, the operator's name and a new password, and
ends every console session of that operator. It cannot reset a Subsonic
user's password.

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

The first Subsonic user, an admin, comes from the `INITIAL_USER` var in
`wrangler.jsonc` and an `INITIAL_PASSWORD` secret, created on the first request
while the user table is empty. It is a Subsonic user only: it cannot sign in to
the console, and it is not an operator. They keep working in this release, and
are how a Subsonic user is created until the console manages them (#82), but
they keep a password in the Worker's secrets: delete `INITIAL_PASSWORD` once
the user exists (`wrangler secret delete INITIAL_PASSWORD`). With
`INITIAL_PASSWORD` set but `INITIAL_USER` or `PASSWORD_ENCRYPTION_KEY` missing,
the Worker warns that no initial Subsonic user was created.

## Scripts

Run from the repository root with `pnpm --filter @stratosonic/server <script>`:

- `dev` builds the console and starts `wrangler dev`.
- `test` runs the Workers-pool tests, then the routing tests.
- `typecheck` regenerates the binding types and type-checks.
- `bench:console-auth` and `bench:startup` measure the console's CPU and the
  Worker's startup cost; see the scripts for how to read them.
