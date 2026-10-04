/**
 * The scan's daily D1 write budget (#84, "Daily D1 write budget (decided)";
 * ADR-0009).
 *
 * A D1 database that reaches the free tier's 100,000 rows written a day
 * refuses **every** query, reads included, until 00:00 UTC (D1 pricing). The
 * scan is the one writer that can get there on its own: a first index of a
 * large library writes 9 to 14 rows per track (measured: about 9.4 for
 * ten-track albums, 13.4 for a track that is its own artist's own album), and
 * the cleanup of a removed one about 2. So the scan driver counts the rows it
 * writes in a UTC day and stops at `SCAN_DAILY_WRITE_BUDGET` (default 50,000;
 * `0` means no cap):
 *
 * - **What is counted** is what D1 says it wrote: the `rows_written` of each
 *   batch's results (`countedBatch`), every statement of the scan, the
 *   cleanup and the playlist import included, never an estimate.
 * - **The tally** is one `property` row, `ScanRowsWritten = {day, rows}`. A
 *   batch's own rows are known only once it has run, so they are counted
 *   from the next write on, in three places, each written anyway:
 *   - a batch that writes tracks (or ends or skips something) adds every
 *     row carried so far to the tally;
 *   - a batch that writes only its progress, as most pages of an unchanged
 *     pass do, carries them in its progress row (`untallied`), so such a
 *     page costs one row written, not two;
 *   - the rows of a step's last batch ride in the driver's own state to the
 *     next step (`RowLedger`, `DriverState.unreported`).
 *   Where nothing comes after - the end of a pass, a pause, a give-up - one
 *   statement puts what is left on the tally (`flushLedger`); only that
 *   statement's own row is counted rather than measured, as the one row an
 *   update of the tally writes. A row from another day counts as nothing.
 * - **The check** before a page also leaves room for the page itself: at the
 *   measured worst case (`WORST_ROWS_PER_INDEXED_TRACK`) for each track the
 *   step may still read, so one page cannot overshoot the budget by much. A
 *   cleanup stage (at most 500 tracks, about 1,000 rows) or a playlist page
 *   is checked before it starts and may overshoot by itself.
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
 * The most rows one indexed track was measured to cost: a track that is its
 * own artist's own album inserts an artist, an album and a track with their
 * indexes, a cover pointer and the album's recompute (about 13.4). The check
 * before a page reserves this much for each track the step may still read;
 * the tally itself counts what D1 reports.
 */
export const WORST_ROWS_PER_INDEXED_TRACK = 14;

/**
 * Rows written that neither the tally nor a progress row holds yet: the
 * rows of the batches a step ran since its last write of either. The driver
 * carries it from one step to the next in its own state.
 */
export interface RowLedger {
  rows: number;
}

/** The rows D1 reports a batch's statements wrote. */
export function rowsWrittenBy(results: readonly unknown[]): number {
  let rows = 0;
  for (const result of results) {
    const written =
      typeof result === "object" && result !== null && "meta" in result
        ? (result as { meta?: { rows_written?: unknown } }).meta?.rows_written
        : undefined;
    if (typeof written === "number" && Number.isFinite(written) && written > 0) {
      rows += written;
    }
  }

  return rows;
}

/**
 * Runs statements as one D1 batch and answers the rows D1 says they wrote.
 * An empty list sends nothing and wrote nothing.
 */
export async function countedBatch(
  db: Database,
  statements: readonly ScanStatement[],
): Promise<number> {
  const [first, ...rest] = statements;
  if (first === undefined) {
    return 0;
  }

  return rowsWrittenBy(await db.batch([first, ...rest]));
}

/**
 * Puts the ledger's rows on the day's tally, where nothing written later
 * would carry them: one statement, whose own row is counted as the one row
 * an update of the tally writes. Nothing is sent for an empty ledger.
 */
export async function flushLedger(db: Database, day: string, ledger: RowLedger): Promise<void> {
  if (ledger.rows <= 0) {
    return;
  }
  const rows = ledger.rows + 1;
  ledger.rows = 0;
  await db.batch([tallyStatement(db, day, rows)]);
}

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
