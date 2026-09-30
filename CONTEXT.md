# Stratosonic

Stratosonic is a Subsonic / OpenSubsonic music server running on Cloudflare
Workers + D1 + R2, replacing a Navidrome instance. It serves one personal music
library to Subsonic clients (primarily Substreamer).

## Language

**Track**:
A single playable audio file in the library, identified by its R2 object key.
_Avoid_: Song, MediaFile, Child.

**Album**:
A group of tracks sharing an album artist, album name, and year.
_Avoid_: Record, Release.

**Artist**:
The album artist an album and its tracks are attributed to; the library groups
by album artist, not by per-track performer.
_Avoid_: Band, Performer, Album Artist (as a separate concept).

**Playlist**:
A user-ordered list of tracks, stored as an `.m3u` in the bucket: the file is
the playlist, and the row indexes it. One a client creates is written to the
bucket first and indexed from there (ADR-0006), so it is the same thing as one
rclone uploaded.
_Avoid_: Queue, Mix.

**Annotation**:
A user's per-item state — starred flag, rating, and play count — keyed by
(user, item, item type). Starts empty; no historical data is imported.
_Avoid_: Favorite, Rating record.

**Playback session**:
What a user is playing right now — one track, its state (starting, playing,
paused), position and rate — one per user, kept until it expires or the
client reports it stopped. A stop far enough into the track counts a play.
_Avoid_: Now-playing entry (that is how `getNowPlaying` renders one), Stream.

**Entity id**:
The stable identifier of an artist, album, track, or playlist: a 22-character
base62 MD5 hash, exposed to clients with a type prefix (`ar-`, `al-`, `tr-`,
`pl-`).
_Avoid_: UUID, key, slug.

**R2 key**:
The object key of a track in the R2 bucket, equal to its original path
(`artist/album/title.ext`); a track's id is derived from this key.
_Avoid_: path, filename (when referring to the storage key).

**Cover art id**:
The opaque id a client passes to `getCoverArt`; for an album it is the album's
own id (`al-<id>`), and an artist reuses its primary album's cover.
_Avoid_: image id, artwork id.

**Subsonic user**:
An account a Subsonic client signs in as, kept in `subsonic_user`, with a
password stored reversibly encrypted (ADR-0003). A Subsonic admin is a
Subsonic user with Subsonic's admin role.
_Avoid_: Account (alone), User (alone, where a console user could be meant).

**Console user**:
An account of the admin console, kept in Better Auth's `user` table, which
signs in to the console and never to Subsonic. It is named by its role (the
only one for now is the owner, of whom there is at most one), and its
password is hashed one way (ADR-0007).
_Avoid_: Admin, Administrator (both mean the Subsonic role), Operator.

**Role**:
What a console user may do: a named set of permissions, which routes check
by permission, never by role name. A role the server does not know grants
nothing.
_Avoid_: Admin flag, Group.

**Scan**:
The scheduled (cron) process in the Worker that reads tags from R2 objects,
extracts cover art, and upserts the library index into D1.
_Avoid_: Import (reserved for playlists), Sync, Index (as a verb).
