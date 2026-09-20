# Entity ids are content-derived MD5 to base62 hashes, following Navidrome

Every entity id is `base62(md5(fields))` rendered as a 22-character string,
matching Navidrome's `id.NewHash` primitive so the scheme is familiar and
collision-resistant. A track's id is the hash of its R2 key (path); an album's
id is the hash of its normalized album-artist + album + year; an artist's id is
the hash of its normalized name. Ids are exposed to clients with type prefixes
(`ar-`, `al-`, `tr-`, `pl-`), and an album's cover-art id is its own id.

## Considered options

- **gonic** uses auto-increment integer primary keys. Rejected: that requires
  stateful id assignment, which our stateless rescan-upsert CLI would have to
  replicate.
- **Current Navidrome** uses opaque random song ids plus a separate `pid` column
  for move detection. Rejected: we accept "a moved file is a new track", so the
  move-detection machinery buys us nothing.

## Consequences

Ids are stable across rescans as long as the path (tracks) or the normalized
name (albums/artists) is unchanged; renaming a file, or retagging an album or
artist name, mints a new id and drops that item's annotations. This is
acceptable because we do not migrate historical data and album/artist-level
stars are rare.
