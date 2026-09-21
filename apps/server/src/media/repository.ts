import type { EntityId } from "@stratosonic/db";
import type { Database } from "../db";
import { NO_USER } from "../library/annotations";
import { findAlbum, findArtist, findTrack } from "../library/repository";

/**
 * Which stored object a client-facing id asks for.
 *
 * The reads themselves belong to `library/repository.ts`, which the browsing
 * endpoints answer from; nothing is queried here. That is deliberate for the
 * artist's cover in particular: `getArtist` tells a client which album lends
 * the artist its `coverArt`, and `getCoverArt` must serve that same album's
 * picture. Two copies of "the first album with a cover" would be two chances
 * to disagree, so this asks the browsing side which album it named.
 */

/**
 * The R2 key of the cover a client-facing id resolves to, or null when there
 * is none — an id naming nothing, a playlist, or an album whose tracks carried
 * no artwork.
 *
 * All three kinds of id end at an album's cover, because an album's cover is
 * the only artwork the library stores (#9): a track shows its album's, and an
 * artist shows one of its albums'.
 *
 * Nothing here answers a caller with an element, so every read is made as
 * `NO_USER`: the cover does not depend on who is asking, and the annotation
 * join is left to match nothing rather than cost a lookup.
 */
export async function findCoverKey(db: Database, entity: EntityId): Promise<string | null> {
  switch (entity.type) {
    case "album":
      return (await findAlbum(db, entity.id, NO_USER))?.coverKey ?? null;

    case "track":
      // A track is read with its album's cover already joined in, so this is
      // one query rather than two.
      return (await findTrack(db, entity.id, NO_USER))?.albumCoverKey ?? null;

    case "artist": {
      const coverAlbumId = (await findArtist(db, entity.id, NO_USER))?.coverAlbumId ?? null;

      return coverAlbumId === null
        ? null
        : ((await findAlbum(db, coverAlbumId, NO_USER))?.coverKey ?? null);
    }

    default:
      return null;
  }
}
