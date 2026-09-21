# The server runs on the Cloudflare free tier; ingestion runs in the Worker on a cron schedule

A single Worker both serves the API (`fetch`) and ingests the library on a
schedule (`scheduled` / cron) — there is no separate CLI. Cron scans R2 (reads
audio headers via Range GET, parses tags, extracts embedded cover art, upserts
artist/album/track into D1, incrementally, skipping unchanged objects by
etag+size) and imports `.m3u` playlists from R2. Music is uploaded to R2 out of
band with rclone; the first admin user is created on first run from the
`INITIAL_USER` / `INITIAL_PASSWORD` variables. We use only D1, R2, the Cache
API and one Durable Object (no Queues), and v1 runs on the `workers.dev` domain
without a custom domain.

**Amendment (#31): one Durable Object drives the scan.** A step of the scan is
bounded by the free plan's 50 subrequests per invocation, which is about six
tracks, and cron cannot tick more than once a minute — so a first pass over
5,000 tracks driven by cron alone takes days. v1 therefore adds a single
SQLite-backed Durable Object, `ScanDriver`, with one well-known instance. It is
a scheduler, not storage: the cron trigger pokes it, its `alarm()` runs one
step and schedules the next about a second later until the scan's pass and the
playlist import are done, and D1's `property` table stays the source of truth
for what a pass has done. The object's own storage holds only the driver's
bookkeeping — the pass in flight, the consecutive-failure count and its
backoff — and is emptied when a pass ends. Queues are still unused, and the
free-tier posture is unchanged: Durable Objects are available on the free plan
with the SQLite backend, the per-step subrequest budget is untouched, and a
full pass over 5,000 tracks costs about 840 of the 100,000 Durable Object
requests a day and a negligible slice of the 13,000 GB-s. The Durable Objects
limits table gives 30 s of CPU per request with no free/paid split, which — if
it holds in production, as #30 will confirm — retires the 10 ms cron CPU risk
named below, because a cron invocation now only pokes.

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
