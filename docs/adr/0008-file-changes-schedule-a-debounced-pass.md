# File changes schedule a debounced pass through the scan driver

Phase 2 lets the owner upload and delete files from the console (#83). The
library has to follow those changes without **Scan now**, and a burst of
them must not cost a pass each. The owner decided the rules (2026-10-02):
every change marks the library changed; a pass starts only after a quiet
window with no further change; many changes make one pass, with at most one
queued; a change during a pass makes exactly one more pass after it, still
debounced; the pending pass lives in the server, not the browser, so closing
the tab cannot lose it; and **Scan now** and the cron stay immediate.

So the scan driver (ADR-0004's #31 amendment) changes from "drives a pass
when poked" to "also debounces file changes". It keeps the latest change in
a second storage key, `pending: { changedAt }`, beside its `driver` state,
and its one alarm serves both jobs. The file routes call
`markLibraryChanged(env, at)` (`scanner/status.ts`), which records the
change in D1 and calls `ScanDriver.touch(at)`. One rule decides every case:

> **A change is pending if and only if `changedAt` is at or after the
> `startedAt` of the latest pass** (the pass in flight, or else the last
> completed one). A pass that started after the change lists the bucket
> after it, so it covers it.

- `touch` keeps the later of the stored and the new `changedAt`. With no
  pass alive it moves the alarm to `changedAt + 2 minutes`, which replaces
  any earlier debounce alarm: that is the reset. With a pass alive it leaves
  the step chain's alarm alone.
- The alarm with no pass in flight is the debounce alarm: with nothing
  pending it is stale; before the deadline it re-arms for it; at the
  deadline it deletes `pending` and starts a pass stamped with that instant.
- A pass that ends with a change pending does not empty the storage: it
  deletes its own state and arms the debounce alarm for one more pass.
- `start` (the cron, **Scan now**, `startScan`) keeps `pending` while a
  pass is alive, and when it starts one, deletes `pending` only if the
  change is older than the poke's stamp. **Scan now** is stamped with the
  wall clock, so it absorbs every change; a cron poke whose scheduled time
  precedes a change leaves it pending, and its pass is followed by one more.
- Giving up after `maxFailures` empties everything, `pending` included; the
  next cron poke resumes from the D1 cursor and covers the change.
- Every decision reads `pending` and acts on storage with no other `await`
  in between, so the input gates deliver no other event in between: a
  `touch` that lands while a step waits on R2 or D1 is seen at its end.

**The window is 2 minutes** (`RESCAN_QUIET_MS`, carried in the driver's
tuning). Navidrome's file watcher is the model: it resets one timer on every
change and scans when it fires, and a scan already running makes it wait
again rather than start a second one (`scanner/watcher.go`,
`trigger.Reset(w.triggerWait)`, "Already scanning, will retry later"). Its
default wait is 5 s (`consts.DefaultWatcherWait`) because it sees each file
the moment it is closed. Our signal is coarser, one report per finished
browser upload, which on a slow uplink arrives about once a minute, so 5 s
would start a pass between most files. 2 minutes covers a one-minute gap
with margin and stays short next to the cron's quarter hour, which remains
the backstop for rclone.

**The console reads the schedule from D1, not the driver.** The routes that
change files also upsert one `property` row, `LibraryChangedAt =
{"at": <ms>}`, which keeps the larger value. `scanReportQuery` reads it with
the scan's other keys, and `GET /api/overview/live` answers `scan.scheduled`
by the same rule: null, the time a pass starts, or `afterCurrentPass`. The
polled route therefore makes no Durable Object request, and the two can
disagree only for the moment between a poke and its first step.

## Consequences

- ADR-0004's #31 note ("emptied when a pass ends") now reads "emptied when a
  pass ends, unless a file change is pending". The object still ceases to
  exist between passes once nothing is pending.
- A change costs one D1 row written and one Durable Object request (two rows
  read, two written); each quiet window costs one more request, and the pass
  it starts costs what a cron pass costs. The debounce never starts more
  passes than the windows allow, so the cron stays the main scan cost.
- In the window, a deleted track is still listed by Subsonic clients, and
  streaming it answers error 70. A playlist file the console deletes leaves
  at once (ADR-0006).
- A lost `touch` (the driver unreachable) is logged, and the change waits
  for the next cron pass, at most 15 minutes away.
