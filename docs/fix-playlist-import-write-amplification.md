# Fix: the playlist import exhausts D1's daily write budget

## What happened

Phase 2 (#37) shipped and the production Worker was to be released as
`v0.2.0`. The deploy failed — not in the code, which passed lint, typecheck and
all 1155 tests, but at the step that applies new D1 migrations to production:

```
✘ [ERROR] Your account has exceeded D1's free tier daily row write limit.
  Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.
```

The free plan allows **100,000 D1 rows written per day**. Something spent all
of them, so the three small Phase 2 migrations (`now_playing`, `play_queue`,
`bookmark`) could not be written and the release stopped before
`wrangler deploy` ran. Production was left on the prior version — a clean stop,
no half-applied migration — but the exhaustion would recur every day until the
cause was removed.

## What the cause is not

The library is small:

| tracks | albums | artists | playlists | playlist entries |
| --- | --- | --- | --- | --- |
| 968 | 296 | 238 | 14 | 912 |

The track scanner was ruled out from production data. The last completed pass
recorded `examined: 1648, indexed: 0, added: 0, updated: 0, unchanged: 968`: the
`etag`+`size` fast path (`scanner/scan.ts`, `planFor`) recognises an unchanged
object and rewrites nothing. An idle scan pass writes only its per-page
progress cursor, about 21 rows for this bucket, so at the `*/15` cron schedule
the scanner costs on the order of 2,000 D1 writes a day. Not the cause.

## The cause

The **playlist import**. By design it re-reads and re-imports every `.m3u` on
every pass rather than skipping unchanged files (`playlists/import.ts`, "Why
every file is read on every pass") — Navidrome's rule, so a line that finds no
track today resolves once the scan indexes that track, and a track the scan
later sweeps drops out of the playlist. That behaviour is correct and stays.

The cost is in how the re-import writes. `upsertPlaylistStatements`
(`playlists/repository.ts`) deletes **all** of a playlist's entries and
re-inserts them:

```
db.delete(playlistTrack).where(eq(playlistTrack.playlistId, imported.id))
// then one INSERT per chunk of entries
```

D1 bills per row written, and deleting N rows plus inserting N rows is 2N
writes — even when the resulting entries are identical to what was stored. For
this library:

| per import pass | rows written |
| --- | --- |
| 912 entry deletes | 912 |
| 912 entry inserts | 912 |
| 14 playlist-row upserts | 14 |
| **total** | **~1,838** |

At `*/15` (96 passes a day) that is **~176,000 D1 row writes a day from the
playlist import alone** — over the whole free-tier budget by itself, before the
scanner or any API write. ADR-0004 called re-importing "cheap because an
`.m3u` is small and there are few of them"; true for R2 reads and subrequests,
wrong for D1 row writes, which the re-import amplifies by twice the entry count
on every pass whether or not anything changed.

## The fix

1. **Make the playlist import idempotent in cost, not only in content.** A pass
   still reads and re-resolves every `.m3u` every time, so newly indexed tracks
   still appear and swept tracks still drop — the Navidrome rule is unchanged.
   What changes: the import **writes nothing when the resolved playlist and its
   full ordered entry set already match what is stored**, and when they differ
   it applies the difference instead of deleting every entry and re-inserting
   it. `changedAt` advances only on a real change. An unchanged pass then costs
   0 playlist writes instead of ~1,838.

2. **Add `startScan` and `getScanStatus`** (admin-only, as in Navidrome).
   `startScan` pokes the existing scan driver — the same `driver.start(...)`
   the cron `scheduled` handler already calls (`index.ts`) — and
   `getScanStatus` reports from the `ScanProgress` / `LastScanSummary` rows the
   scan already keeps in the `property` table, returning
   `<scanStatus scanning="…" count="…"/>` in XML and JSON. Music arrives out of
   band via rclone; with a manual trigger the owner scans the moment an upload
   finishes instead of waiting for cron.

## What we are not doing

- **The cron schedule stays `*/15` for now.** Once the import is idempotent an
  idle pass costs ~0 writes, so the schedule is no longer what drains the
  budget. Lengthening it is a separate, optional change and is not made here.

- **Not skipping an `.m3u` that is unchanged and already fully resolved.** It
  would save the R2 read and the re-parse, neither of which is the constraint,
  while adding per-file state (the object's etag and a "fully resolved" flag)
  and the duty to invalidate it whenever the scan touches a track the playlist
  points at. Once fix 1 lands an unchanged re-import already writes nothing, so
  this buys no write savings for real added complexity.

## After the fix

- The steady-state D1 write cost of a pass drops from ~1,838 rows to ~0 when
  nothing changed, so the daily budget is no longer consumed by idle scanning.
- The `v0.2.0` deploy is retried after the 00:00 UTC reset carrying this fix,
  and the exhaustion does not recur.
- Faithfulness to Navidrome is preserved: every `.m3u` is still re-resolved on
  every pass; only the redundant write is elided. `startScan` / `getScanStatus`
  follow Subsonic 1.15.0+.
- Tests assert the behaviour over HTTP, as the rest of the suite does: a second
  import pass over an unchanged bucket writes no rows, a changed `.m3u` writes
  only its delta, `startScan` starts a pass and `getScanStatus` reports it, and
  both endpoints require an admin.
