# The server runs on the Cloudflare free tier; ingestion runs in the Worker on a cron schedule

A single Worker both serves the API (`fetch`) and ingests the library on a
schedule (`scheduled` / cron) — there is no separate CLI. Cron scans R2 (reads
audio headers via Range GET, parses tags, extracts embedded cover art, upserts
artist/album/track into D1, incrementally, skipping unchanged objects by
etag+size) and imports `.m3u` playlists from R2. Music is uploaded to R2 out of
band with rclone; the first admin user is created on first run from the
`INITIAL_USER` / `INITIAL_PASSWORD` variables. We use only D1, R2, and the Cache
API (no Durable Objects or Queues), and v1 runs on the `workers.dev` domain
without a custom domain.

## Consequences

- Keeping everything server-side mirrors Navidrome (its scanner also runs inside
  the always-on server), and avoids shipping and running a separate tool.
- The one open risk is the free tier's 10 ms CPU limit for tag parsing in cron;
  if it proves insufficient, upgrade to Workers Paid (30 s CPU), optionally with
  a Durable Object to orchestrate scanning. This changes cost, not architecture.
- On `workers.dev` the Cache API is inert, so cover/list edge caching is
  deferred; adding a custom domain later turns it on with no code change.
- The sole recurring cost is R2 storage (about $0.015/GB-month).

_Supersedes the earlier plan to run ingestion in a local CLI: Workers cron
triggers make server-side scheduled ingestion possible, which is both simpler
and closer to Navidrome._
