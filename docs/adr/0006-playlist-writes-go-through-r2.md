# A client's playlist writes go through R2, which stays the source of truth

R2 holds the playlists; D1 only indexes them. A playlist exists because an
`.m3u` exists in the bucket, and the cron import (`playlists/import.ts`) makes
the rows agree with the files on every pass. `createPlaylist` and
`deletePlaylist` do not change that: they write the file and let the same rules
produce the row.

Concretely, a create renders the `.m3u`, `put`s it to R2, and *then* upserts the
row with the importer's own statements, with the id derived from the key by
`playlistId(r2Key)` exactly as the import derives it. A delete removes the
object first and the row second. Both orders follow from one rule: a failure
between the two writes must leave an `.m3u` with no row — which the next pass
imports — never a row with no file, which the sweep would delete and a listener
would watch vanish. The timestamps come from the object R2 just stored, not
from our clock, because that is what every later import stamps the row with, so
a client write and a cron pass converge on identical rows.

A new playlist's file is `playlists/<random id>.m3u`. The key is never derived
from the name: two playlists called "Mix" would otherwise be one file, the
second create silently overwriting the first, and the id — the hash of the key
— would move when a listener renamed the playlist. The name lives in the
`#PLAYLIST:` line, where the parser already reads it from, and the lines are
the tracks' own R2 keys, which the import resolves from the root of the bucket
wherever the file sits.

The import's sweep removes only rows created before the pass began. Between
listing a page and sweeping it there is a window in which a client can create a
playlist whose key falls in that page: the pass cannot have seen it, and
without this rule would delete it seconds after the listener made it.

## Consequences

- **The owner's upload workflow must not use `rclone sync` over the prefix a
  client writes to.** `sync` makes the bucket match the local side and would
  delete every playlist created from a client, because those files exist only
  in the bucket. Use `rclone copy`, or exclude `playlists/` (for example
  `--exclude 'playlists/**'`) from the sync.
- A playlist made in a client is an ordinary playlist: it can be edited by hand
  in the bucket, it survives a rebuilt database, and it needs no column saying
  where it came from.
- The `MUSIC` binding is read-write for the Worker, which it already was for
  the covers the scan extracts.
- A `put` that R2 refuses fails the request with no row written, and an
  orphaned `.m3u` left by a crash becomes a playlist on the next pass rather
  than rubbish nothing reads.
