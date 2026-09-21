/**
 * The caller's annotation, joined into a read so every `<song>`, `<album>` and
 * `<artist>` a client sees carries what that account has done to it: whether it
 * is starred, its rating, and — for songs and albums — its play count and last
 * play. This is the one seam `star`, `setRating` and `scrobble` light up; the
 * serializers render from it, and the reads join it in.
 *
 * It is always a **left** join keyed by the authenticated user, so an item the
 * caller has never touched comes back with no annotation (every column `null`)
 * and renders exactly as it did before Phase 2, and a second account added
 * later sees nothing of the first's. Because the join fixes the user, the item
 * and the item type against a table keyed by all three, it matches at most one
 * row and never multiplies the result.
 *
 * The annotation rides in the same statement as the row it decorates — no
 * endpoint pays a second D1 query for it — which is why the columns and the
 * join condition live here, to be spread into whatever select already reads
 * the item.
 */

import { type AnnotationItemType, annotation } from "@stratosonic/db";
import { and, eq, type SQL, type SQLWrapper } from "drizzle-orm";
import type { CallerAnnotation } from "./serializers";

/**
 * The annotation columns a decorated read selects, named so they cannot
 * collide with the item's own columns when the two are spread together.
 */
export const annotationColumns = {
  annotationStarred: annotation.starred,
  annotationStarredAt: annotation.starredAt,
  annotationRating: annotation.rating,
  annotationPlayCount: annotation.playCount,
  annotationPlayDate: annotation.playDate,
};

/**
 * The user a read serves when it serves no caller — an internal read that only
 * needs the item's own row, such as resolving a cover. No account has an empty
 * id, so the left join matches nothing and the item comes back undecorated.
 *
 * It is a named constant, and every read takes its user explicitly, so that a
 * read never loses its decoration by simply forgetting to say whose it is.
 */
export const NO_USER = "";

/**
 * The `ON` of the left join that brings in one item's row for the caller.
 * `itemId` is the item table's id column, compared against the annotation's.
 */
export function annotationJoin(
  userId: string,
  itemType: AnnotationItemType,
  itemId: SQLWrapper,
): SQL {
  return and(
    eq(annotation.userId, userId),
    eq(annotation.itemType, itemType),
    eq(annotation.itemId, itemId),
  ) as SQL;
}

/**
 * A decorated row's annotation columns. Drizzle types a partial select's
 * left-joined columns as non-null, but the join can miss, so they are read
 * here as nullable — a narrower non-null value is assignable to this, so a
 * caller passes its row straight in.
 */
export interface AnnotationRow {
  readonly annotationStarred: boolean | null;
  readonly annotationStarredAt: Date | null;
  readonly annotationRating: number | null;
  readonly annotationPlayCount: number | null;
  readonly annotationPlayDate: Date | null;
}

/**
 * The caller's annotation pulled out of a decorated row, or `null` when the
 * left join found none. A row that exists but says nothing — starred once and
 * unstarred, say — comes back as an annotation whose every attribute the
 * serializers omit, so it renders the same as no row at all.
 */
export function toCallerAnnotation(row: AnnotationRow): CallerAnnotation | null {
  // Every joined column is null together when there is no row; `starred` has a
  // non-null default, so its being null is the unambiguous "no row" signal.
  if (row.annotationStarred === null) {
    return null;
  }

  return {
    starred: row.annotationStarred,
    starredAt: row.annotationStarredAt,
    rating: row.annotationRating ?? 0,
    playCount: row.annotationPlayCount ?? 0,
    playDate: row.annotationPlayDate,
  };
}
