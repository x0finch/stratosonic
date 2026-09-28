/**
 * The version of what the scanner reads from a track's tags.
 *
 * Every track row records the version that last read it (`track.scan_version`),
 * and the scan treats a row below this one as changed even when its etag and
 * size still match, so it is read again and the rows it yields are written
 * with this version. That is how a scanner that learns to read something new
 * reaches the tracks it indexed before it did.
 *
 * - **1** - embedded lyrics (#69).
 *
 * Bumping it forces a one-time re-read of the whole library: every track is
 * read and upserted once more, about ten thousand D1 rows written for a
 * library of a thousand tracks, spread over the scan's usual bounded steps.
 * Bump it only when a re-read would store something a previous version did
 * not.
 *
 * A version marker, rather than a migration that clears the stored etags,
 * because only this code knows what it means: the scanner that ran before the
 * marker existed - still live between `wrangler d1 migrations apply` and
 * `wrangler deploy`, or for good if a deploy fails - neither reads nor writes
 * it, so it can never use up the re-read on the new version's behalf.
 */
export const SCAN_VERSION = 1;
