import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_TIME_QUERY,
  DURABLE_OBJECT_MEMORY_MB,
  FREE_TIER_LIMITS,
  forgetCachedUsage,
  GRAPHQL_ENDPOINT,
  R2_CLASS_A_ACTIONS,
  R2_CLASS_B_ACTIONS,
  readUsage,
  USAGE_QUERY,
  USAGE_TTL_MS,
  type UsageAnswer,
} from "../src/usage/analytics";
import activeTimeSample from "./fixtures/cloudflare-active-time-response.json";
import sample from "./fixtures/cloudflare-usage-response.json";

/**
 * The usage panel's GraphQL client and its isolate cache (#82, "API: usage
 * panel"; #117), with `fetch` injected.
 *
 * test/fixtures/cloudflare-usage-response.json is built from the response
 * shapes Cloudflare documents (the Workers metrics tutorial's answer, the D1,
 * Durable Objects and R2 metrics pages' fields), under the aliases of
 * `USAGE_QUERY`. test/fixtures/cloudflare-active-time-response.json answers
 * `ACTIVE_TIME_QUERY`, whose `durableObjectsPeriodicGroups.sum.activeTime` is
 * the one field no Cloudflare page names; the first live call confirms it,
 * and its answers can replace these samples.
 */

const TOKEN = "cf-analytics-token-do-not-leak-0123456789";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CONFIGURED = { CF_ANALYTICS_TOKEN: TOKEN, CF_ACCOUNT_ID: ACCOUNT };

/** 2026-10-01T12:34:56.789Z. */
const NOON = Date.UTC(2026, 9, 1, 12, 34, 56, 789);

type Answer = () => Response | Promise<Response>;

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
  /** Which of the two queries the call sent. */
  readonly kind: "usage" | "activeTime";
}

/**
 * A `fetch` standing in for Cloudflare's GraphQL API: each query is answered
 * with the next of its answers (the last one again once they run out), and
 * every call is recorded.
 */
function fakeFetch(usage: Answer | Answer[], activeTime: Answer | Answer[] = activeTimeAnswer) {
  const answers = {
    usage: Array.isArray(usage) ? usage : [usage],
    activeTime: Array.isArray(activeTime) ? activeTime : [activeTime],
  };
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { query } = JSON.parse(String(init?.body));
    const kind = query === ACTIVE_TIME_QUERY ? "activeTime" : "usage";
    calls.push({ url: String(input), init, kind });
    const sent = calls.filter((call) => call.kind === kind).length;
    const list = answers[kind];
    const answer = list[Math.min(sent, list.length) - 1];
    if (!answer) {
      throw new Error(`no answer for this ${kind} call`);
    }
    return answer();
  }) as typeof fetch;
  return { impl, calls, kinds: () => calls.map((call) => call.kind) };
}

/** An answer of `body` as JSON. */
function json(body: unknown, status = 200) {
  return () => Response.json(body, { status });
}
const sampleAnswer = json(sample);
function activeTimeAnswer() {
  return Response.json(activeTimeSample);
}

const BUDGET = {
  data: null,
  errors: [
    {
      extensions: { code: "budget", timestamp: "2026-10-01T12:00:00Z" },
      message: `Account ${ACCOUNT} has exceeded its rate limit. Please try again after 5 minutes.`,
      path: null,
    },
  ],
};

const AUTHZ = {
  data: null,
  errors: [
    {
      extensions: { code: "authz" },
      message: "not authorized for that account",
      path: ["viewer", "accounts", "0"],
    },
  ],
};

/** An answer whose one account block is `account`. */
function accountAnswer(account: Record<string, unknown>) {
  return json({ data: { viewer: { accounts: [account] } }, errors: null });
}

async function read(
  fetchImpl: typeof fetch,
  at = NOON,
  env: Record<string, string> = CONFIGURED,
): Promise<UsageAnswer> {
  return readUsage(env, { fetch: fetchImpl, now: () => at });
}

async function report(fetchImpl: typeof fetch, at = NOON) {
  const answer = await read(fetchImpl, at);
  if (answer.status !== "ok") {
    throw new Error(`expected a report, got ${JSON.stringify(answer)}`);
  }
  return answer.report;
}

beforeEach(() => {
  forgetCachedUsage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("without both secrets", () => {
  it.each([
    ["neither", {}],
    ["both empty, as in CI", { CF_ANALYTICS_TOKEN: "", CF_ACCOUNT_ID: "" }],
    ["only the account id", { CF_ACCOUNT_ID: ACCOUNT }],
    ["only whitespace", { CF_ANALYTICS_TOKEN: " \n", CF_ACCOUNT_ID: ACCOUNT }],
    ["only the token", { CF_ANALYTICS_TOKEN: TOKEN }],
  ])("is unconfigured with %s, and never fetches", async (_, env) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, calls } = fakeFetch(sampleAnswer);

    expect(await read(impl, NOON, env)).toEqual({ status: "unconfigured" });
    expect(calls).toEqual([]);
  });

  it("warns once per isolate about a token without an account id", async () => {
    // This file's isolate may already have warned; either way, never again.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = fakeFetch(sampleAnswer);
    for (let i = 0; i < 3; i++) {
      await read(impl, NOON, { CF_ANALYTICS_TOKEN: TOKEN, CF_ACCOUNT_ID: "" });
    }

    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    for (const args of warn.mock.calls) {
      expect(String(args[0])).toMatch(/CF_ACCOUNT_ID is not/);
    }
  });
});

describe("the request", () => {
  it("is two POSTs, the main query then the active time, with the token as a bearer", async () => {
    const { impl, calls, kinds } = fakeFetch(sampleAnswer);
    await report(impl);

    expect(kinds()).toEqual(["usage", "activeTime"]);
    for (const { url, init } of calls) {
      expect(url).toBe(GRAPHQL_ENDPOINT);
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("content-type")).toBe("application/json");
    }
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      query: USAGE_QUERY,
      variables: {
        account: ACCOUNT,
        day: "2026-10-01",
        yesterday: "2026-09-30",
        dayStart: "2026-10-01T00:00:00Z",
        now: "2026-10-01T12:34:56.789Z",
        monthStart: "2026-10-01T00:00:00Z",
        storageSince: "2026-09-30T12:34:56.789Z",
      },
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      query: ACTIVE_TIME_QUERY,
      variables: { account: ACCOUNT, yesterday: "2026-09-30" },
    });
  });

  it("does not ask for the active time when the main query fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, kinds } = fakeFetch(json({}, 500));

    expect(await read(impl)).toEqual({ status: "unavailable", reason: "upstream" });
    expect(kinds()).toEqual(["usage"]);
  });

  it("reads storage over the last 24 hours, so just after midnight still finds a sample", async () => {
    const { impl, calls } = fakeFetch(sampleAnswer);
    const answer = await report(impl, Date.UTC(2026, 9, 1, 0, 5, 0));

    const { variables } = JSON.parse(String(calls[0]?.init?.body));
    expect(variables).toMatchObject({
      day: "2026-10-01",
      dayStart: "2026-10-01T00:00:00Z",
      monthStart: "2026-10-01T00:00:00Z",
      storageSince: "2026-09-30T00:05:00.000Z",
    });
    expect(USAGE_QUERY).toMatch(
      /r2StorageAdaptiveGroups\([^)]*datetime_geq: \$storageSince, datetime_leq: \$now/,
    );
    // The counters keep their own windows.
    expect(USAGE_QUERY).toMatch(
      /workersInvocationsAdaptive\([^)]*datetime_geq: \$dayStart, datetime_leq: \$now/,
    );
    expect(USAGE_QUERY).toMatch(
      /r2OperationsAdaptiveGroups\([^)]*datetime_geq: \$monthStart, datetime_leq: \$now/,
    );
    expect(answer.r2.storageBytes).toBe(52_345_678_901);
  });

  it("covers the month to date for R2, from the first of the month", async () => {
    const { impl, calls } = fakeFetch(sampleAnswer);
    const answer = await report(impl, Date.UTC(2026, 1, 28, 23, 59, 59));

    const { variables } = JSON.parse(String(calls[0]?.init?.body));
    expect(variables).toMatchObject({
      day: "2026-02-28",
      yesterday: "2026-02-27",
      dayStart: "2026-02-28T00:00:00Z",
      monthStart: "2026-02-01T00:00:00Z",
    });
    expect(answer).toMatchObject({ day: "2026-02-28", monthStart: "2026-02-01" });
  });

  it("takes yesterday across a month and a year", async () => {
    for (const [at, yesterday] of [
      [Date.UTC(2026, 2, 1, 0, 0, 0), "2026-02-28"],
      [Date.UTC(2027, 0, 1, 23, 59, 59), "2026-12-31"],
    ] as const) {
      forgetCachedUsage();
      const { impl, calls } = fakeFetch(sampleAnswer);
      await report(impl, at);

      expect(JSON.parse(String(calls[0]?.init?.body)).variables.yesterday).toBe(yesterday);
    }
  });

  it("keeps the unverified field out of the main query, alone in its own", () => {
    expect(USAGE_QUERY).not.toContain("activeTime");
    expect(USAGE_QUERY).toMatch(/durableObjectsPeriodicGroups\([^)]*\) \{\s*sum \{ cpuTime \}/);
    expect(ACTIVE_TIME_QUERY).toMatch(
      /durableObjectsPeriodicGroups\([^)]*\) \{\s*sum \{ activeTime \}/,
    );
    expect(ACTIVE_TIME_QUERY.match(/\w+Groups\(/g)).toEqual(["durableObjectsPeriodicGroups("]);
  });

  it("filters the Durable Object datasets with date_gt, the operator their docs show", () => {
    for (const query of [USAGE_QUERY, ACTIVE_TIME_QUERY]) {
      for (const match of query.matchAll(/durableObjects\w+\(([^)]*)\)/g)) {
        expect(match[1]).toContain("filter: { date_gt: $yesterday }");
      }
    }
    expect(USAGE_QUERY.match(/date_gt/g)).toHaveLength(2);
  });

  it("asks for up to 1,000 buckets, the free plan's most", () => {
    expect(USAGE_QUERY).toMatch(/r2StorageAdaptiveGroups\(limit: 1000,/);
  });

  it("asks for every dataset in one accounts block", () => {
    expect(USAGE_QUERY.match(/accounts\(/g)).toHaveLength(1);
    for (const dataset of [
      "workersInvocationsAdaptive",
      "d1AnalyticsAdaptiveGroups",
      "durableObjectsInvocationsAdaptiveGroups",
      "durableObjectsPeriodicGroups",
      "r2OperationsAdaptiveGroups",
      "r2StorageAdaptiveGroups",
    ]) {
      expect(USAGE_QUERY).toContain(`${dataset}(`);
    }
  });
});

describe("the report", () => {
  it("is the sample's account-wide totals, next to the free plan's limits", async () => {
    const { impl } = fakeFetch(sampleAnswer);

    expect(await report(impl)).toEqual({
      configured: true,
      fetchedAt: "2026-10-01T12:34:56.789Z",
      day: "2026-10-01",
      monthStart: "2026-10-01",
      workers: { requests: 1234, errors: 2, limit: { requests: 100_000 } },
      d1: {
        rowsRead: 81234,
        rowsWritten: 412,
        limit: { rowsRead: 5_000_000, rowsWritten: 100_000 },
      },
      durableObjects: {
        requests: 840,
        cpuTimeMs: 51234,
        durationGbSeconds: 312.5,
        limit: { requests: 100_000, durationGbSeconds: 13_000 },
      },
      r2: {
        classA: 1200,
        classB: 34000,
        storageBytes: 52_345_678_901,
        objectCount: 6100,
        limit: { classA: 1_000_000, classB: 10_000_000, storageBytes: 10_000_000_000 },
      },
    });
  });

  it("carries the limits of FREE_TIER_LIMITS", async () => {
    const { impl } = fakeFetch(sampleAnswer);
    const answer = await report(impl);

    expect(answer.workers.limit).toEqual(FREE_TIER_LIMITS.workers);
    expect(answer.d1.limit).toEqual(FREE_TIER_LIMITS.d1);
    expect(answer.durableObjects.limit).toEqual(FREE_TIER_LIMITS.durableObjects);
    expect(answer.r2.limit).toEqual(FREE_TIER_LIMITS.r2);
  });

  it("computes GB-s as the pricing page does: seconds of active time × 128 MB / 1 GB", async () => {
    // The page's own example: 1,000,000 seconds is 128,000 GB-s.
    const { impl } = fakeFetch(
      accountAnswer({ doPeriodic: [{ sum: { cpuTime: 1_500 } }, { sum: { cpuTime: 500 } }] }),
      accountAnswer({
        doPeriodic: [
          { sum: { activeTime: 400_000_000_000 } },
          { sum: { activeTime: 600_000_000_000 } },
        ],
      }),
    );
    const { durableObjects } = await report(impl);

    expect(DURABLE_OBJECT_MEMORY_MB).toBe(128);
    expect(durableObjects.durationGbSeconds).toBe(128_000);
    expect(durableObjects.cpuTimeMs).toBe(2);
  });

  it("counts each R2 action in its pricing class, and drops free and unknown ones", async () => {
    const rows = [
      ...[...R2_CLASS_A_ACTIONS].map((actionType) => ({ actionType, requests: 1 })),
      ...[...R2_CLASS_B_ACTIONS].map((actionType) => ({ actionType, requests: 10 })),
      { actionType: "DeleteObject", requests: 1000 },
      { actionType: "DeleteBucket", requests: 1000 },
      { actionType: "AbortMultipartUpload", requests: 1000 },
      { actionType: "SomethingNew", requests: 1000 },
    ].map(({ actionType, requests }) => ({ dimensions: { actionType }, sum: { requests } }));
    const { impl } = fakeFetch(accountAnswer({ r2Ops: rows }));
    const { r2 } = await report(impl);

    expect(R2_CLASS_A_ACTIONS.size).toBe(15);
    expect(R2_CLASS_B_ACTIONS.size).toBe(8);
    expect(r2.classA).toBe(15);
    expect(r2.classB).toBe(80);
  });

  it.each([
    ["PutObject", "classA"],
    ["ListObjects", "classA"],
    ["CompleteMultipartUpload", "classA"],
    ["GetObject", "classB"],
    ["HeadObject", "classB"],
  ] as const)("counts %s as %s", async (actionType, expected) => {
    const { impl } = fakeFetch(
      accountAnswer({ r2Ops: [{ dimensions: { actionType }, sum: { requests: 7 } }] }),
    );
    const { r2 } = await report(impl);

    expect(r2[expected]).toBe(7);
    expect(r2[expected === "classA" ? "classB" : "classA"]).toBe(0);
  });

  it("answers 0 for a dataset with no rows: nothing was used", async () => {
    const { impl } = fakeFetch(
      accountAnswer({
        workers: [],
        d1: [],
        doInvocations: [],
        doPeriodic: [],
        r2Ops: [],
        r2Storage: [],
      }),
      accountAnswer({ doPeriodic: [] }),
    );
    const answer = await report(impl);

    expect(answer.workers).toMatchObject({ requests: 0, errors: 0 });
    expect(answer.d1).toMatchObject({ rowsRead: 0, rowsWritten: 0 });
    expect(answer.durableObjects).toMatchObject({
      requests: 0,
      cpuTimeMs: 0,
      durationGbSeconds: 0,
    });
    expect(answer.r2).toMatchObject({ classA: 0, classB: 0, storageBytes: 0, objectCount: 0 });
  });

  it("answers null, not a crash, for a missing dataset or field", async () => {
    const { impl } = fakeFetch(
      accountAnswer({
        workers: [{ sum: { requests: 5 } }],
        d1: [{ sum: { rowsRead: "many" } }],
        doPeriodic: [{ sum: { cpuTime: 1000 } }],
        r2Ops: [{ dimensions: {}, sum: { requests: 3 } }],
        r2Storage: [{ max: { objectCount: 9 } }],
      }),
      accountAnswer({ doPeriodic: [{ sum: {} }] }),
    );
    const answer = await report(impl);

    expect(answer.workers).toMatchObject({ requests: 5, errors: null });
    expect(answer.d1).toMatchObject({ rowsRead: null, rowsWritten: null });
    expect(answer.durableObjects).toMatchObject({
      requests: null,
      cpuTimeMs: 1,
      durationGbSeconds: null,
    });
    expect(answer.r2).toMatchObject({ classA: 0, classB: 0, storageBytes: null, objectCount: 9 });
  });
});

describe("the cache", () => {
  it("fetches once for two calls within 5 minutes", async () => {
    const { impl, kinds } = fakeFetch(sampleAnswer);

    const firstAnswer = await read(impl, NOON);
    const second = await read(impl, NOON + USAGE_TTL_MS.ok - 1);

    expect(kinds()).toEqual(["usage", "activeTime"]);
    expect(second).toEqual(firstAnswer);
  });

  it("fetches again once 5 minutes have passed", async () => {
    const { impl, kinds } = fakeFetch(sampleAnswer);

    await read(impl, NOON);
    const later = await read(impl, NOON + USAGE_TTL_MS.ok);

    expect(kinds()).toEqual(["usage", "activeTime", "usage", "activeTime"]);
    expect(later).toMatchObject({ report: { fetchedAt: "2026-10-01T12:39:56.789Z" } });
  });

  it("fetches again for another account", async () => {
    const { impl, calls } = fakeFetch(sampleAnswer);

    await read(impl, NOON);
    await read(impl, NOON + 1, { ...CONFIGURED, CF_ACCOUNT_ID: "f".repeat(32) });

    expect(calls.filter((call) => call.kind === "usage")).toHaveLength(2);
  });

  it("shares no promise: two calls at once each fetch", async () => {
    const { impl, calls } = fakeFetch(sampleAnswer);

    await Promise.all([read(impl, NOON), read(impl, NOON)]);

    expect(calls.filter((call) => call.kind === "usage")).toHaveLength(2);
  });

  it("keeps a rate limit for 5 minutes, the API's window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, kinds } = fakeFetch([json(BUDGET), sampleAnswer]);

    expect(await read(impl, NOON)).toEqual({ status: "unavailable", reason: "rate_limited" });
    expect(await read(impl, NOON + USAGE_TTL_MS.rate_limited - 1)).toEqual({
      status: "unavailable",
      reason: "rate_limited",
    });
    expect(kinds()).toEqual(["usage"]);

    expect(await read(impl, NOON + USAGE_TTL_MS.rate_limited)).toMatchObject({ status: "ok" });
    expect(kinds()).toEqual(["usage", "usage", "activeTime"]);
    expect(USAGE_TTL_MS.rate_limited).toBe(5 * 60_000);
  });

  it("keeps an upstream failure for 1 minute", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl, kinds } = fakeFetch([json({ error: "boom" }, 500), sampleAnswer]);

    expect(await read(impl, NOON)).toEqual({ status: "unavailable", reason: "upstream" });
    await read(impl, NOON + 60_000 - 1);
    expect(kinds()).toEqual(["usage"]);

    expect(await read(impl, NOON + 60_000)).toMatchObject({ status: "ok" });
    expect(kinds()).toEqual(["usage", "usage", "activeTime"]);
  });
});

describe("a failure", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each([
    ["HTTP 401", json({ success: false, errors: [{ code: 10000 }] }, 401), "unauthorized"],
    ["HTTP 403", json({ success: false }, 403), "unauthorized"],
    ["an authz error", json(AUTHZ), "unauthorized"],
    [
      "an authentication error",
      json({ data: null, errors: [{ message: "authentication error", path: null }] }),
      "unauthorized",
    ],
    ["a budget error", json(BUDGET), "rate_limited"],
    ["HTTP 429", json({}, 429), "rate_limited"],
    ["HTTP 500", json({}, 500), "upstream"],
    [
      "another GraphQL error",
      json({ data: null, errors: [{ message: "unknown field", extensions: { code: "x" } }] }),
      "upstream",
    ],
    [
      "data with errors",
      json({ ...sample, errors: [{ message: "timeout", extensions: { code: "timeout" } }] }),
      "upstream",
    ],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 }), "upstream"],
    ["no account block", json({ data: { viewer: { accounts: [] } }, errors: null }), "upstream"],
    [
      "a network error",
      () => {
        throw new TypeError("network connection lost");
      },
      "upstream",
    ],
  ] as const)("maps %s to %s", async (_, answer, reason) => {
    const { impl } = fakeFetch(answer);

    expect(await read(impl)).toEqual({ status: "unavailable", reason });
  });

  it("logs the error path, which tells a dataset out of reach from a bad token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = fakeFetch(
      json(
        {
          data: null,
          errors: [
            {
              message: "does not have access to the path",
              path: ["viewer", "accounts", 0, "r2Storage"],
              extensions: { code: "authz" },
            },
          ],
        },
        403,
      ),
    );

    expect(await read(impl)).toEqual({ status: "unavailable", reason: "unauthorized" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("(unauthorized)"), {
      status: 403,
      codes: ["authz"],
      paths: ["viewer/accounts/0/r2Storage"],
    });
  });

  it("lets go of the body of a 429 unread", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const { impl } = fakeFetch(() => new Response(body, { status: 429 }));

    expect(await read(impl)).toEqual({ status: "unavailable", reason: "rate_limited" });
    expect(cancelled).toBe(true);
  });
});

describe("the active-time query", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it.each([
    [
      "rejects the field",
      json({
        data: null,
        errors: [
          {
            message: 'unknown field "activeTime"',
            path: ["viewer", "accounts", 0, "doPeriodic"],
            extensions: { code: "x" },
          },
        ],
      }),
    ],
    ["answers HTTP 500", json({}, 500)],
    ["is rate limited", json(BUDGET)],
    [
      "fails on the network",
      () => {
        throw new TypeError("network connection lost");
      },
    ],
  ] as const)("only leaves the duration out when it %s", async (_, answer) => {
    const { impl } = fakeFetch(sampleAnswer, answer);
    const answered = await report(impl);

    expect(answered.durableObjects).toEqual({
      requests: 840,
      cpuTimeMs: 51234,
      durationGbSeconds: null,
      limit: FREE_TIER_LIMITS.durableObjects,
    });
    expect(answered.workers.requests).toBe(1234);
    expect(answered.r2.storageBytes).toBe(52_345_678_901);
  });

  it("warns once per isolate when it fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { impl } = fakeFetch(sampleAnswer, json({}, 500));

    await read(impl, NOON);
    await read(impl, NOON + USAGE_TTL_MS.ok);

    const lines = warn.mock.calls.filter(([line]) => String(line).includes("active-time"));
    expect(lines).toEqual([[expect.stringContaining("(upstream)"), { status: 500 }]]);
  });
});

describe("the token", () => {
  it("never appears in an answer or a log line", async () => {
    const lines: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      });
    }

    const answers: UsageAnswer[] = [];
    const failures: Answer[] = [
      json(BUDGET),
      json(AUTHZ),
      json({}, 401),
      json({}, 500),
      () => new Response("not json"),
      () => {
        throw new Error(`failed with ${TOKEN}`);
      },
    ];
    const pairs: [Answer, Answer][] = [
      [sampleAnswer, activeTimeAnswer],
      ...failures.map((answer): [Answer, Answer] => [answer, activeTimeAnswer]),
      ...failures.map((answer): [Answer, Answer] => [sampleAnswer, answer]),
    ];
    for (const [usage, activeTime] of pairs) {
      forgetCachedUsage();
      answers.push(await read(fakeFetch(usage, activeTime).impl));
    }
    answers.push(await read(fakeFetch(sampleAnswer).impl, NOON, { CF_ANALYTICS_TOKEN: TOKEN }));

    expect(answers.map((answer) => answer.status)).toContain("ok");
    expect(lines.length).toBeGreaterThan(0);
    const seen = JSON.stringify({ answers, lines: lines.map((args) => args.map(String)) });
    expect(seen).not.toContain(TOKEN);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });
});
