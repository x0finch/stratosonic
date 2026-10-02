import { describe, expect, it } from "vitest";

import type { ConfiguredUsage } from "@/lib/api";
import { MISSING } from "@/lib/format";
import {
  closestToLimit,
  describeClosest,
  shareOf,
  type UsageGroup,
  usageGroups,
  usedOfLimit,
} from "@/lib/usage";

function usage(overrides: Partial<ConfiguredUsage> = {}): ConfiguredUsage {
  return {
    configured: true,
    fetchedAt: "2026-10-02T04:00:00.000Z",
    day: "2026-10-02",
    monthStart: "2026-10-01",
    workers: { requests: 18_234, errors: 12, limit: { requests: 100_000 } },
    d1: {
      rowsRead: 1_834_567,
      rowsWritten: 5_400,
      limit: { rowsRead: 5_000_000, rowsWritten: 100_000 },
    },
    durableObjects: {
      requests: 2_100,
      cpuTimeMs: 3_200,
      durationGbSeconds: 410,
      limit: { requests: 100_000, durationGbSeconds: 13_000 },
    },
    r2: {
      classA: 3_200,
      classB: 241_000,
      storageBytes: 8_120_000_000,
      objectCount: 24_780,
      limit: { classA: 1_000_000, classB: 10_000_000, storageBytes: 10_000_000_000 },
    },
    ...overrides,
  };
}

/** Every metric's value set to `null`, as an answer that carried none. */
function withoutFigures(groups: UsageGroup[]): UsageGroup[] {
  return groups.map((group) => ({
    ...group,
    metrics: group.metrics.map((metric) => ({ ...metric, value: null })),
  }));
}

describe("the usage list", () => {
  it("has one row per metric, grouped by service", () => {
    const groups = usageGroups(usage());
    expect(groups.map((group) => group.service)).toEqual([
      "Workers",
      "D1",
      "Durable Objects",
      "R2",
    ]);
    expect(groups.map((group) => group.metrics.map((metric) => metric.label))).toEqual([
      ["Requests"],
      ["Rows read", "Rows written"],
      ["Requests", "Duration"],
      ["Class A operations", "Class B operations", "Storage, 24-hour peak"],
    ]);
  });

  it("writes each value of its limit, with the limit's unit", () => {
    const metrics = usageGroups(usage()).flatMap((group) => group.metrics);
    expect(metrics.map(usedOfLimit)).toEqual([
      "18,234 of 100,000",
      "1,834,567 of 5,000,000",
      "5,400 of 100,000",
      "2,100 of 100,000",
      "410 of 13,000 GB-s",
      "3,200 of 1,000,000",
      "241,000 of 10,000,000",
      "8.1 GB of 10 GB",
    ]);
  });

  it("puts the figures no limit applies to under the row they qualify", () => {
    const notes = usageGroups(usage())
      .flatMap((group) => group.metrics)
      .filter((metric) => metric.note)
      .map((metric) => [metric.name, metric.note]);
    expect(notes).toEqual([
      ["Workers requests", "12 errors"],
      ["Durable Object duration", "CPU time 3,200 ms, not limited"],
      ["R2 storage, 24-hour peak", "24,780 objects"],
    ]);
  });

  it("says a figure the answer left out with a dash, and gives it no share", () => {
    const requests = usageGroups(
      usage({ workers: { requests: null, errors: null, limit: { requests: 100_000 } } }),
    )[0]?.metrics[0];
    if (requests === undefined) {
      throw new Error("no Workers requests row");
    }
    expect(usedOfLimit(requests)).toBe(`${MISSING} of 100,000`);
    expect(requests.note).toBe(`${MISSING} errors`);
    expect(shareOf(requests)).toBeNull();
  });
});

describe("the metric closest to its limit", () => {
  it("is the one with the largest share, in plain words", () => {
    const groups = usageGroups(usage());
    expect(closestToLimit(groups)?.name).toBe("R2 storage, 24-hour peak");
    expect(describeClosest(groups)).toBe("R2 storage is at 81% of the free 10 GB.");
  });

  it("compares shares, not figures", () => {
    const groups = usageGroups(
      usage({
        d1: {
          rowsRead: 100_000,
          rowsWritten: 95_000,
          limit: { rowsRead: 5_000_000, rowsWritten: 100_000 },
        },
      }),
    );
    expect(describeClosest(groups)).toBe("D1 rows written are at 95% of the free 100,000.");
  });

  it("names the first of those that tie, and a share past the limit", () => {
    const tied = usageGroups(
      usage({
        workers: { requests: 50_000, errors: 0, limit: { requests: 100_000 } },
        d1: {
          rowsRead: 2_500_000,
          rowsWritten: 0,
          limit: { rowsRead: 5_000_000, rowsWritten: 100_000 },
        },
        r2: { ...usage().r2, storageBytes: 0 },
      }),
    );
    expect(describeClosest(tied)).toBe("Workers requests are at 50% of the free 100,000.");

    const over = usageGroups(
      usage({ workers: { requests: 120_000, errors: 0, limit: { requests: 100_000 } } }),
    );
    expect(describeClosest(over)).toBe("Workers requests are at 120% of the free 100,000.");
  });

  it("is a small share in its own words, and nothing without any figure", () => {
    const quiet = usageGroups(
      usage({
        workers: { requests: 12, errors: 0, limit: { requests: 100_000 } },
        d1: { rowsRead: 0, rowsWritten: 0, limit: { rowsRead: 5_000_000, rowsWritten: 100_000 } },
        durableObjects: {
          requests: 0,
          cpuTimeMs: 0,
          durationGbSeconds: 650,
          limit: { requests: 100_000, durationGbSeconds: 13_000 },
        },
        r2: { ...usage().r2, classA: 0, classB: 0, storageBytes: 0 },
      }),
    );
    expect(describeClosest(quiet)).toBe(
      "Durable Object duration is at 5.0% of the free 13,000 GB-s.",
    );
    expect(closestToLimit(withoutFigures(quiet))).toBeNull();
    expect(describeClosest(withoutFigures(quiet))).toBe("");
  });
});
