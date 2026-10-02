import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatClock,
  formatCount,
  formatDuration,
  formatLength,
  formatPercent,
  formatRelative,
  MISSING,
} from "@/lib/format";

describe("the Overview's numbers", () => {
  it("groups counts", () => {
    expect(formatCount(5012)).toBe("5,012");
    expect(formatCount(0)).toBe("0");
  });

  it("writes a length of time in its two largest units", () => {
    expect(formatDuration(1_234_567.8)).toBe("14 d 6 h");
    expect(formatDuration(86_400)).toBe("1 d");
    expect(formatDuration(7_500)).toBe("2 h 5 min");
    expect(formatDuration(3_600)).toBe("1 h");
    expect(formatDuration(2_460)).toBe("41 min");
    expect(formatDuration(12.4)).toBe("12 s");
    expect(formatDuration(0)).toBe("0 s");
  });

  it("writes a position as a player does", () => {
    expect(formatClock(241_300)).toBe("4:01");
    expect(formatClock(3_723_000)).toBe("1:02:03");
    expect(formatClock(0)).toBe("0:00");
  });

  it("writes a length in one clock format, whatever its size", () => {
    expect(formatLength(28)).toBe("0:28");
    expect(formatLength(59.6)).toBe("1:00");
    expect(formatLength(241.3)).toBe("4:01");
    expect(formatLength(3_599)).toBe("59:59");
    expect(formatLength(3_600)).toBe("1:00:00");
    expect(formatLength(3_723)).toBe("1:02:03");
    expect(formatLength(36_000)).toBe("10:00:00");
    expect(formatLength(0)).toBe("0:00");
    expect(formatLength(-5)).toBe("0:00");
  });

  it("writes sizes in decimal units", () => {
    expect(formatBytes(98_765_432_100)).toBe("98.8 GB");
    expect(formatBytes(10_000_000_000)).toBe("10.0 GB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(123_456_789)).toBe("123 MB");
  });

  it("writes a limit's size as the round number it is", () => {
    expect(formatBytes(10_000_000_000, 0)).toBe("10 GB");
    expect(formatBytes(8_120_000_000, 0)).toBe("8 GB");
    expect(formatBytes(8_120_000_000, 2)).toBe("8.12 GB");
  });

  it("writes a share of a limit", () => {
    expect(formatPercent(1_234, 100_000)).toBe("1.2%");
    expect(formatPercent(52_345, 100_000)).toBe("52%");
    expect(formatPercent(1, 0)).toBe(MISSING);
    expect(MISSING).toBe("\u2014");
  });

  it("says how long ago", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(formatRelative("2026-10-01T12:00:00Z", now)).toBe("just now");
    expect(formatRelative("2026-10-01T11:59:30Z", now)).toBe("30 seconds ago");
    expect(formatRelative("2026-10-01T11:55:00Z", now)).toBe("5 minutes ago");
    expect(formatRelative("2026-10-01T09:00:00Z", now)).toBe("3 hours ago");
    expect(formatRelative("2026-09-30T12:00:00Z", now)).toBe("yesterday");
    expect(formatRelative("2026-09-01T12:00:00Z", now)).toBe("last month");
    expect(formatRelative("2024-10-01T12:00:00Z", now)).toBe("2 years ago");
    expect(formatRelative("not a date", now)).toBe("");
  });

  it("says just now of an instant up to a few minutes ahead of this browser's clock", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(formatRelative("2026-10-01T12:00:03Z", now)).toBe("just now");
    expect(formatRelative("2026-10-01T12:05:00Z", now)).toBe("just now");
    // Further ahead is no clock skew, and is written as it is.
    expect(formatRelative("2026-10-01T12:06:00Z", now)).toBe("in 6 minutes");
    expect(formatRelative("2026-10-01T14:00:00Z", now)).toBe("in 2 hours");
  });
});
