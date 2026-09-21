import { type Track, track } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import type { Database } from "../db";

/** The reads the media endpoints make. */

/** The track a `tr-` id names, or null when no row has that id. */
export async function findTrackById(db: Database, id: string): Promise<Track | null> {
  const rows = await db.select().from(track).where(eq(track.id, id)).limit(1);

  return rows[0] ?? null;
}
