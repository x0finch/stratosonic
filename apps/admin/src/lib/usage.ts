import type { ConfiguredUsage, UsageFigure } from "@/lib/api";
import { formatBytes, formatCount, formatPercent, MISSING } from "@/lib/format";

/**
 * The free-tier usage panel's rows (#82, #128): one per metric, grouped by
 * service, each against its own limit, and which one is closest to its
 * limit. The Overview's panel only lays them out.
 */

/** One metric against its free-tier limit. */
export interface UsageMetric {
  /** What its row shows, under its service's heading: `Rows read`. */
  label: string;
  /** What it measures in full, for assistive technology: `D1 rows read`. */
  name: string;
  /** The subject of the description's sentence, with its verb: `D1 rows read are`. */
  subject: string;
  value: UsageFigure;
  limit: number;
  /** How the value is written, with its unit if it has one: `1,834,567`, `8.1 GB`, `410 GB-s`. */
  format: (value: number) => string;
  /**
   * How the limit is written, a round figure in the value's unit:
   * `5,000,000`, `10 GB`, `13,000 GB-s`.
   */
  formatLimit: (value: number) => string;
  /** A figure the row's metadata line adds, which no limit applies to. */
  note?: string;
}

/** One service's metrics, under its name. */
export interface UsageGroup {
  service: string;
  metrics: UsageMetric[];
}

const wholeCount = (value: number) => formatCount(Math.round(value));
/** A byte limit is a round number of units: `10 GB`, not `10.0 GB`. */
const wholeBytes = (value: number) => formatBytes(value, 0);
/** Durable Object duration, in its unit on both sides: `410 GB-s of 13,000 GB-s`. */
const gbSeconds = (value: number) => `${wholeCount(value)} GB-s`;

/** A figure in words, or the dash for one Cloudflare's answer left out. */
export function formatFigure(
  value: UsageFigure,
  format: (value: number) => string = wholeCount,
): string {
  return value === null ? MISSING : format(value);
}

/**
 * The panel's rows, by service, in the order Cloudflare's pricing page lists
 * them. Durable Objects are limited by requests and duration on the free
 * plan, not CPU, which is a note under duration; Workers errors and R2's
 * object count are notes under the row they qualify.
 */
export function usageGroups(usage: ConfiguredUsage): UsageGroup[] {
  const count = { format: wholeCount, formatLimit: wholeCount };
  return [
    {
      service: "Workers",
      metrics: [
        {
          label: "Requests",
          name: "Workers requests",
          subject: "Workers requests are",
          value: usage.workers.requests,
          limit: usage.workers.limit.requests,
          ...count,
          note: `${formatFigure(usage.workers.errors)} errors`,
        },
      ],
    },
    {
      service: "D1",
      metrics: [
        {
          label: "Rows read",
          name: "D1 rows read",
          subject: "D1 rows read are",
          value: usage.d1.rowsRead,
          limit: usage.d1.limit.rowsRead,
          ...count,
        },
        {
          label: "Rows written",
          name: "D1 rows written",
          subject: "D1 rows written are",
          value: usage.d1.rowsWritten,
          limit: usage.d1.limit.rowsWritten,
          ...count,
        },
      ],
    },
    {
      service: "Durable Objects",
      metrics: [
        {
          label: "Requests",
          name: "Durable Object requests",
          subject: "Durable Object requests are",
          value: usage.durableObjects.requests,
          limit: usage.durableObjects.limit.requests,
          ...count,
        },
        {
          label: "Duration",
          name: "Durable Object duration",
          subject: "Durable Object duration is",
          value: usage.durableObjects.durationGbSeconds,
          limit: usage.durableObjects.limit.durationGbSeconds,
          format: gbSeconds,
          formatLimit: gbSeconds,
          note: `CPU time ${formatFigure(usage.durableObjects.cpuTimeMs)} ms, not limited`,
        },
      ],
    },
    {
      service: "R2",
      metrics: [
        {
          label: "Class A operations",
          name: "R2 Class A operations",
          subject: "R2 Class A operations are",
          value: usage.r2.classA,
          limit: usage.r2.limit.classA,
          ...count,
        },
        {
          label: "Class B operations",
          name: "R2 Class B operations",
          subject: "R2 Class B operations are",
          value: usage.r2.classB,
          limit: usage.r2.limit.classB,
          ...count,
        },
        {
          label: "Storage, 24-hour peak",
          name: "R2 storage, 24-hour peak",
          subject: "R2 storage is",
          value: usage.r2.storageBytes,
          limit: usage.r2.limit.storageBytes,
          format: formatBytes,
          formatLimit: wholeBytes,
          note: `${formatFigure(usage.r2.objectCount)} objects`,
        },
      ],
    },
  ];
}

/** A metric's value against its limit, for its row: `8.1 GB of 10 GB`. */
export function usedOfLimit(metric: UsageMetric): string {
  return `${formatFigure(metric.value, metric.format)} of ${metric.formatLimit(metric.limit)}`;
}

/** A metric's share of its limit, 0 to 1 and beyond, or `null` without a figure. */
export function shareOf(metric: Pick<UsageMetric, "value" | "limit">): number | null {
  return metric.value === null || metric.limit <= 0 ? null : metric.value / metric.limit;
}

/**
 * The metric with the largest share of its limit, the first of those that
 * tie; `null` when no metric has a figure, or none has used any of its
 * limit, so that no metric is closer than another.
 */
export function closestToLimit(groups: readonly UsageGroup[]): UsageMetric | null {
  let closest: UsageMetric | null = null;
  let largest = 0;
  for (const metric of groups.flatMap((group) => group.metrics)) {
    const share = shareOf(metric);
    if (share !== null && share > largest) {
      closest = metric;
      largest = share;
    }
  }
  return closest;
}

/**
 * The description's sentence on the metric closest to its limit, in plain
 * words: `R2 storage is at 81% of the free 10 GB.` Empty when there is none
 * (`closestToLimit`).
 */
export function describeClosest(groups: readonly UsageGroup[]): string {
  const metric = closestToLimit(groups);
  if (metric === null || metric.value === null) {
    return "";
  }
  return `${metric.subject} at ${formatPercent(metric.value, metric.limit)} of the free ${metric.formatLimit(metric.limit)}.`;
}
