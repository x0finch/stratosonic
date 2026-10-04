/**
 * The scan's daily D1 write budget (#84, "Daily D1 write budget (decided)";
 * ADR-0009).
 *
 * A D1 database that reaches the free tier's 100,000 rows written a day
 * refuses **every** query, reads included, until 00:00 UTC (D1 pricing). The
 * scan is the one writer that can get there on its own: a first index of a
 * large library, or the cleanup of a removed one, writes about eight rows per
 * track. So the scan driver counts the rows it writes in a UTC day and stops
 * at `SCAN_DAILY_WRITE_BUDGET` (default 50,000; `0` means no cap):
 *
 * - **The tally** is one `property` row, `ScanRowsWritten = {day, rows}`,
 *   added to in the page batches of the scan, the playlist import and the
 *   cleanup of a removed library. A row from another day counts as nothing.
 *   A page that writes nothing but its progress row - most pages of an
 *   unchanged pass - does not write the tally: its row is carried in the
 *   progress row itself (`untallied`), which the page writes anyway, and
 *   joins the tally with the next batch that writes more, or at the end of
 *   the pass. So an unchanged page costs one row written, not two, and the
 *   cron's unchanged passes stay at about 115 rows each.
 * - **What is counted** is an estimate of each batch's rows written: its
 *   progress rows (the cursor, the memo, the library stamps and the tally
 *   itself), plus about 8 rows per indexed track (`ROWS_PER_INDEXED_TRACK`)
 *   and about 6 per removed one (`ROWS_PER_REMOVED_TRACK`).
 * - **The pause.** A step that finds the day's tally at the budget does no
 *   work and reports itself paused. The driver then ends the pass as a
 *   give-up does: its state is cleared, a pending file change is kept, no
 *   alarm is set and the D1 cursor stays, so every cron poke that UTC day
 *   stops at its first step's check, and the first poke after midnight
 *   resumes the pass.
 *
 * Workers Paid has no daily limit, so `0` turns the cap off. The limit is per
 * account, so a preview database shares it.
 */

import { property } from "@stratosonic/db";
import { sql } from "drizzle-orm";
import type { Database } from "../db";
import type { Env } from "../env";
import type { ScanStatement } from "./repository";

/** The `property` row the tally is kept in. */
export const SCAN_ROWS_WRITTEN_KEY = "ScanRowsWritten";

/** `SCAN_DAILY_WRITE_BUDGET` when it is unset or not a whole number. */
export const DEFAULT_SCAN_DAILY_WRITE_BUDGET = 50_000;

/**
 * Rows a newly indexed or re-read track costs: its artist, album and track
 * upserts, their indexes, the album's recompute and, now and then, a lyrics
 * row and a cover pointer.
 */
export const ROWS_PER_INDEXED_TRACK = 8;

/**
 * Rows a removed track costs: the track and its indexes, its lyrics and
 * playlist entries by cascade, and the album recompute.
 */
export const ROWS_PER_REMOVED_TRACK = 6;

/** The tally, as the row holds it. */
export interface RowsWritten {
  /** The UTC day the rows were written on, `YYYY-MM-DD`. */
  readonly day: string;
  readonly rows: number;
}

/**
 * The budget this deployment runs with: `SCAN_DAILY_WRITE_BUDGET` as a whole
 * number, `0` for no cap, and the default for anything else.
 */
export function dailyWriteBudget(env: Env): number {
  // Typed as the string wrangler.jsonc gives, and checked as anything,
  // since a var can also be set by hand in the dashboard.
  const value: unknown = env.SCAN_DAILY_WRITE_BUDGET;
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d{1,15}$/.test(text.trim())) {
    return DEFAULT_SCAN_DAILY_WRITE_BUDGET;
  }

  return Number(text.trim());
}

/** The UTC day an instant falls on, as the tally names it. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The first instant of the UTC day after the one `at` falls on. */
export function nextUtcMidnight(at: number): number {
  const day = new Date(at);

  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
}

/** The tally from its stored JSON, or null when the row is absent or unreadable. */
export function readRowsWritten(stored: Record<string, unknown> | undefined): RowsWritten | null {
  if (stored === undefined) {
    return null;
  }

  const { day, rows } = stored;
  if (typeof day !== "string" || typeof rows !== "number" || !Number.isFinite(rows) || rows < 0) {
    return null;
  }

  return { day, rows: Math.floor(rows) };
}

/** The rows the tally holds for `day`: nothing when it is another day's. */
export function rowsWrittenOn(tally: RowsWritten | null, day: string): number {
  return tally !== null && tally.day === day ? tally.rows : 0;
}

/** Whether `spent` rows have reached the budget; never, with no cap. */
export function budgetReached(spent: number, budget: number): boolean {
  return budget > 0 && spent >= budget;
}

/**
 * Adds `rows` to the tally for `day`, in the batch whose rows they are. A row
 * of another day, or one that will not parse, starts the day afresh, so the
 * count is atomic however two writers interleave.
 */
export function tallyStatement(db: Database, day: string, rows: number): ScanStatement {
  const fresh = JSON.stringify({ day, rows });

  return db
    .insert(property)
    .values({ id: SCAN_ROWS_WRITTEN_KEY, value: fresh })
    .onConflictDoUpdate({
      target: property.id,
      set: {
        value: sql`case
          when json_valid(${property.value})
            and json_extract(${property.value}, '$.day') = ${day}
            and json_type(${property.value}, '$.rows') in ('integer', 'real')
          then json_object('day', ${day}, 'rows', json_extract(${property.value}, '$.rows') + ${rows})
          else ${fresh}
        end`,
      },
    });
}
