# Libraries: the bound bucket is library 1, and more buckets are connected at runtime

Phase 3 (#84) serves several buckets, each as a **library**, following
Navidrome's multi-library model (migration
`20250701010108_add_multi_library_support.go`, `model/library.go`). A
`library` table holds one row per bucket, `user_library` says which Subsonic
users may see which library (admins see every one), and every read is
filtered to the caller's libraries, with `musicFolderId` validated and
honoured where Navidrome honours it (`selectedMusicFolderIds`).

**Storage is an interface, not a binding.** Worker bindings are static, so a
bucket connected from the console can only be reached through the S3 API over
`fetch`. Every use of the bucket therefore goes through one interface (`list`,
`head`, ranged `get`, `put`, `delete`, `presignPut`) with two
implementations:

- the `MUSIC` binding, which stays **library 1**. It is created by the
  migration, can never be removed, and is what `wrangler.jsonc` binds;
- an S3 client signed with SigV4 by `aws4fetch`.

A connected bucket's credentials (an R2 API token with Object Read & Write on
that bucket) are stored in D1, sealed with AES-256-GCM:

- the key is HKDF-SHA256 over `PASSWORD_ENCRYPTION_KEY`, `info`
  `stratosonic/storage-credentials/v1`, beside the derivations ADR-0007 and
  the console already use;
- the library's storage URI is the additional authenticated data, so a path
  change re-seals the credentials.

Each library has a unique storage URI as its `path`, as Navidrome's
libraries do (`core/storage/storage.go`): `r2-binding://MUSIC` for library 1,
and `s3://<endpoint host>/<bucket>` for the others.

**Library 1's ids never change.** As Navidrome's legacy id path skips the
library prefix for its default library (`model/metadata/legacy_ids.go`), a
library-1 track, album or playlist keeps the id ADR-0002 gives it. In any
other library, the library id is hashed in as a leading part:

- a track is `newHashId(String(id), key)`;
- an album is `newHashId(String(id), albumArtist, album, year)`;
- a playlist is `newHashId(String(id), key)`.

So the same key in two buckets is two tracks, and an album is per library.
The epic's wording was "hash `libraryId:path`". A leading part is used instead,
deliberately: our ids are `NewHash` over parts, each ended by U+200B
(ADR-0002), so a leading part is unambiguous. An album cannot collide with
library 1's, because names are stripped of U+200B. A track would collide only
with a library-1 key that begins with the library's digits and U+200B, and the
track and playlist upserts refuse to overwrite a row of another library.
Artists stay `newHashId(name)` and are shared across libraries, as
Navidrome's `artistID` is computed without the library
(`persistent_ids.go`). Which libraries an artist appears in is derived from
its albums, so there is no `library_artist` table. Library ids are
autoincrement and never reused.

**Covers stay in the bound bucket.** Every library's extracted covers are
written to library 1's `_covers/`, keyed by the album id (already per
library). `getCoverArt` keeps reading them through the binding, and a
read-only or unreachable bucket keeps its covers. Navidrome likewise keeps
artwork out of the music folders.

**A playlist file lives in a library,** as ADR-0006's playlists live in the
bucket. Its entries resolve in its own library. An entry that starts with
another library's `path` resolves there, which is Navidrome's absolute-path
matching across libraries (`core/playlists/parse_m3u.go`). Client-created
playlists are still written to library 1.

**The scan walks every library.** One pass:

1. cleans up libraries being removed;
2. scans each active library in id order, from its own cursor;
3. prunes once;
4. imports playlists from every library.

A library whose bucket listing refuses the credentials, or keeps failing, is
skipped for that pass and reported, and its tracks are never swept.

ADR-0008's debounce keeps its single rule, and the pass it starts walks every
library. Navidrome's watcher also keeps one timer for every library, but
scans only the changed folders (`scanner/watcher.go`, `ScanTarget{LibraryID,
FolderPath}`). We keep the timer and not the targeting:

- an unchanged library costs a listing (about one Class A operation per 90
  objects, and one alarm per 270);
- per-library pending sets would complicate the one rule ADR-0008 rests on.

**The scan has a daily D1 write budget.** A D1 that reaches its free daily
writes refuses every query until 00:00 UTC. So the scan counts its rows,
progress rows included, against `SCAN_DAILY_WRITE_BUDGET` (default 50,000; 0
means no cap). The unchanged cron passes alone write about 11,000 a day. At
the budget a pass stops as a give-up does, and the next UTC day resumes it.

**Removing a library disconnects it.** Its tracks and albums leave the index
with their annotations and bookmarks, as Navidrome's cascade and GC remove
them, and its playlists, by ADR-0006's rule. Shared artists with albums
elsewhere stay. The bucket is never touched. Because there is no foreign key
from tracks or albums to `library` and D1 caps a day's writes, the row is
marked `removing` at once (invisible to every reader) and the scan driver
deletes the rest in bounded steps.

**Rolling back to v0.5.0 needs an index back.** Migration 0009 replaces the
unique index on `track.r2_key` with one on `(library_id, r2_key)`, which
v0.5.0's queries cannot use: they name no library. Against a 0009 database,
v0.5.0's scan walk (`findTracksInRange`: `r2_key > ? and r2_key <= ? order by
r2_key limit 90`) and its lookup by key (`findTracksByKeys`) table-scan
`track`, the walk with a temporary B-tree for its order: about 5,090 rows read
per page instead of 90 at 5,000 tracks, tens of millions a day at the
15-minute cron (about 33 million, as measured in review) against the free
tier's 5 million, after which D1 refuses every query.
So a rollback also runs

```sql
CREATE INDEX track_r2_key_idx ON track (r2_key);
```

which turns both plans back into index searches, and rolling forward again
drops it (`DROP INDEX track_r2_key_idx`). It is not part of 0009 because every
track write would pay for a second key index. The alternative is
`PRAGMA optimize` (or `ANALYZE`): with statistics SQLite reaches the new index
by a skip-scan over `library_id`, although the walk still sorts the rest of
its range rather than stopping at 90 rows, so the index is the better remedy.
`playlist` loses its key index the same way, but holds a handful of rows.
Either way the rollback is safe only while one library exists: v0.5.0 knows
nothing of `library_id`, and its scan would sweep every other library's
tracks.

## Considered options

- **A binding per bucket.** Rejected: bindings are declared in
  `wrangler.jsonc` and need a redeploy, which the epic rules out for
  connecting a bucket.
- **Prefixing library 1's ids too** (Navidrome's non-legacy persistent ids
  always prepend the library). Rejected: every star, rating, play count,
  playlist entry and play queue entry would be orphaned on upgrade, against
  this project's rule that a migration keeps the listener's data.
- **Navidrome's literal `"N\path"` string prefix.** Not adopted: our ids are
  `NewHash` over parts (ADR-0002), not Navidrome's raw legacy MD5, so its
  bytes are unattainable anyway, and a leading hash part keeps the parts
  unambiguous.
- **Covers in each library's own bucket.** Rejected: each `getCoverArt` would
  need a credential read and a signed external request, and a read-only
  bucket could hold no cover.
- **A `library_artist` table** as in Navidrome. Rejected: a Stratosonic
  artist exists only through its albums, so the table would be a second copy
  the scan must keep in step.

## Consequences

- **ADR-0002** now reads: ids are content-derived as before. Library 1's are
  exactly as before. Other libraries' tracks, albums and playlists hash their
  library id as a leading part. Artists are shared. A track's identity is its
  library and its key, so moving a file between libraries mints a new id.
- **ADR-0004** now reads: the Worker binds one bucket, which is library 1.
  Further R2 buckets are reached through the S3 API with credentials stored
  in D1. An S3 call costs one subrequest, as the binding call it replaces is
  counted, so the scan's per-step budget (42 of 50) is unchanged. The scan
  also spends at most `SCAN_DAILY_WRITE_BUDGET` D1 rows a day, so a large
  first index or removal is spread over days rather than exhausting D1.
  Connecting a bucket in another Cloudflare account bills that account.
- **ADR-0006** applies per library: a playlist's row goes when its file's
  library is removed, and its writes go to its own library, failing on a
  read-only one.
- **ADR-0008** is unchanged in rule; the debounced pass walks every library.
- Rotating `PASSWORD_ENCRYPTION_KEY` now also makes stored bucket credentials
  unreadable, and those libraries must be given their token again.
- Each connected bucket needs its own CORS rule for console uploads, applied
  by the owner (the stored token is not an admin token).
- R2's free Class A operations are shared by all buckets of an account, and
  the scan's listings grow with the total number of objects across libraries.
- Reconnecting a removed bucket creates a new library, with new ids. Its old
  annotations do not return, as in Navidrome.

_Amends ADR-0002 (entity ids) and ADR-0004 (one bound bucket)._
