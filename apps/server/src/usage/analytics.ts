import type { Env } from "../env";

/**
 * The console's free-tier usage panel (#82, "API: usage panel"): today's
 * usage of the whole Cloudflare account, read from Cloudflare's GraphQL
 * Analytics API with a read-only token, next to the free plan's limits.
 *
 * The free-tier limits are per account, so the numbers are account-wide
 * totals, not filtered by script, database or bucket. Every dataset is in one
 * query, sent as one `POST`: one subrequest per refresh. The result is cached
 * in the isolate, never in D1 (which would write a row per refresh) nor in the
 * Cache API (inert on `workers.dev`, ADR-0004).
 *
 * The token is only ever sent to Cloudflare: what the console gets is numbers,
 * and what the log gets is a reason, an HTTP status and error codes.
 */

/** Cloudflare's GraphQL Analytics API. */
export const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/**
 * The free plan's limits, as the panel compares usage with them. Daily limits
 * reset at 00:00 UTC; R2's are per month.
 */
export const FREE_TIER_LIMITS = {
  // developers.cloudflare.com/workers/platform/limits/: "Requests:
  // 100,000/day", resetting at midnight UTC.
  workers: { requests: 100_000 },
  // developers.cloudflare.com/d1/platform/pricing/: "Rows read: 5 million /
  // day", "Rows written: 100,000 / day".
  d1: { rowsRead: 5_000_000, rowsWritten: 100_000 },
  // developers.cloudflare.com/durable-objects/platform/pricing/, "Compute
  // billing": "Requests: 100,000 / day", "Duration: 13,000 GB-s / day".
  durableObjects: { requests: 100_000, durationGbSeconds: 13_000 },
  // developers.cloudflare.com/r2/pricing/, "Free tier": "Storage: 10
  // GB-month / month", "Class A Operations: 1 million requests / month",
  // "Class B Operations: 10 million requests / month".
  r2: { classA: 1_000_000, classB: 10_000_000, storageBytes: 10_000_000_000 },
} as const;

/**
 * The memory a Durable Object's duration is billed at, in MB, whatever it
 * uses. GB-s are seconds × 128 MB / 1 GB, as the Durable Objects pricing
 * page's examples compute them ("1,000,000 seconds * 128 MB / 1 GB = 128,000
 * GB-s").
 */
export const DURABLE_OBJECT_MEMORY_MB = 128;

/**
 * R2 operations by class, from the R2 pricing page's lists
 * (developers.cloudflare.com/r2/pricing/, "Class A operations", "Class B
 * operations"). Its free operations (`DeleteObject`, `DeleteBucket`,
 * `AbortMultipartUpload`) count toward neither, and nor does an action type
 * the page does not name.
 */
export const R2_CLASS_A_ACTIONS: ReadonlySet<string> = new Set([
  "ListBuckets",
  "PutBucket",
  "ListObjects",
  "PutObject",
  "CopyObject",
  "CompleteMultipartUpload",
  "CreateMultipartUpload",
  "LifecycleStorageTierTransition",
  "ListMultipartUploads",
  "UploadPart",
  "UploadPartCopy",
  "ListParts",
  "PutBucketEncryption",
  "PutBucketCors",
  "PutBucketLifecycleConfiguration",
]);
export const R2_CLASS_B_ACTIONS: ReadonlySet<string> = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

/**
 * The one query. Every dataset and field is named in Cloudflare's docs
 * (the Workers metrics tutorial, and the D1, Durable Objects and R2 metrics
 * pages) except `durableObjectsPeriodicGroups.sum.activeTime`, which those
 * pages leave to introspection: the first live call confirms it (#117).
 *
 * Groups without dimensions add up the whole filter, so one row comes back
 * for each of those; R2 groups by action type and by bucket.
 *
 * The counters cover today (UTC) and, for R2's operations, the month to date.
 * Storage is a level, not a counter, so it covers the last 24 hours instead:
 * a window from midnight would hold no sample just after 00:00 UTC, and read
 * as an empty account.
 */
export const USAGE_QUERY = `query Usage($account: string!, $day: Date!, $dayStart: Time!, $now: Time!, $monthStart: Time!, $storageSince: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workers: workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $dayStart, datetime_leq: $now }) {
      sum { requests errors }
    }
    d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: { date_geq: $day, date_leq: $day }) {
      sum { rowsRead rowsWritten }
    }
    doInvocations: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: { date_geq: $day, date_leq: $day }) {
      sum { requests }
    }
    doPeriodic: durableObjectsPeriodicGroups(limit: 1, filter: { date_geq: $day, date_leq: $day }) {
      sum { cpuTime activeTime }
    }
    r2Ops: r2OperationsAdaptiveGroups(limit: 100, filter: { datetime_geq: $monthStart, datetime_leq: $now }) {
      sum { requests } dimensions { actionType }
    }
    r2Storage: r2StorageAdaptiveGroups(limit: 100, filter: { datetime_geq: $storageSince, datetime_leq: $now }) {
      max { payloadSize metadataSize objectCount } dimensions { bucketName }
    }
  } }
}`;

/**
 * What the panel shows. A number Cloudflare's answer did not carry is `null`
 * rather than a guess: a field renamed upstream blanks one figure instead of
 * failing the panel. A dataset with no rows is `0`: nothing was used.
 */
export interface UsageReport {
  readonly configured: true;
  /** When the GraphQL data was fetched. */
  readonly fetchedAt: string;
  /** The UTC day the daily figures cover, and the first day of its month. */
  readonly day: string;
  readonly monthStart: string;
  readonly workers: {
    readonly requests: number | null;
    readonly errors: number | null;
    readonly limit: typeof FREE_TIER_LIMITS.workers;
  };
  readonly d1: {
    readonly rowsRead: number | null;
    readonly rowsWritten: number | null;
    readonly limit: typeof FREE_TIER_LIMITS.d1;
  };
  readonly durableObjects: {
    readonly requests: number | null;
    /** For information: the free plan limits duration, not CPU. */
    readonly cpuTimeMs: number | null;
    readonly durationGbSeconds: number | null;
    readonly limit: typeof FREE_TIER_LIMITS.durableObjects;
  };
  /**
   * Operations month to date, since R2's free tier is monthly; storage is
   * each bucket's peak over the last 24 hours, added up.
   */
  readonly r2: {
    readonly classA: number | null;
    readonly classB: number | null;
    readonly storageBytes: number | null;
    readonly objectCount: number | null;
    readonly limit: typeof FREE_TIER_LIMITS.r2;
  };
}

/**
 * Why the panel has no numbers: Cloudflare refused the token (or its
 * account), its rate limit (`extensions.code = "budget"`) was reached, or
 * anything else went wrong on the way.
 */
export type UsageFailure = "unauthorized" | "rate_limited" | "upstream";

export type UsageAnswer =
  | { readonly status: "unconfigured" }
  | { readonly status: "ok"; readonly report: UsageReport }
  | { readonly status: "unavailable"; readonly reason: UsageFailure };

type Outcome = Exclude<UsageAnswer, { status: "unconfigured" }>;

/** How long each outcome is kept. */
export const USAGE_TTL_MS = {
  ok: 5 * 60_000,
  // The API's rate-limit window: asking again sooner only fails again.
  rate_limited: 5 * 60_000,
  // A refused token stays refused until the secret changes, and a changed
  // secret is a new Worker version, with new isolates.
  unauthorized: 5 * 60_000,
  upstream: 60_000,
} as const satisfies Record<"ok" | UsageFailure, number>;

/** How long the GraphQL request may take before it counts as `upstream`. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The isolate's last outcome. Only a resolved value is kept, never a promise
 * shared across requests, as in setup/initial-setup.ts: a request awaiting
 * I/O begun by another request's context can be cancelled out from under it.
 * Several requests, or several isolates, may therefore each fetch once, which
 * stays far below the API's 300 queries per 5 minutes.
 */
let cached: { accountId: string; value: Outcome; expiresAt: number } | null = null;

/** Whether this isolate has reported a token without an account id. */
let warnedAboutMissingAccount = false;

export interface UsageDependencies {
  /** The `fetch` the GraphQL request goes through. */
  readonly fetch: typeof fetch;
  /** The clock, in epoch milliseconds. */
  readonly now?: () => number;
}

/**
 * The usage panel's answer: `unconfigured` without both secrets (and nothing
 * fetched), otherwise the cached outcome while it lasts, and a fresh one
 * fetched with one GraphQL request when it does not.
 */
export async function readUsage(
  env: Pick<Env, "CF_ANALYTICS_TOKEN" | "CF_ACCOUNT_ID">,
  dependencies: UsageDependencies,
): Promise<UsageAnswer> {
  const config = usageConfig(env);
  if (!config) {
    return { status: "unconfigured" };
  }

  const now = (dependencies.now ?? Date.now)();
  if (cached && cached.accountId === config.accountId && now < cached.expiresAt) {
    return cached.value;
  }

  const value = await fetchUsage(config, dependencies.fetch, now);
  const ttl = value.status === "ok" ? USAGE_TTL_MS.ok : USAGE_TTL_MS[value.reason];
  cached = { accountId: config.accountId, value, expiresAt: now + ttl };
  return value;
}

/** Forgets the cached outcome. For tests. */
export function forgetCachedUsage(): void {
  cached = null;
}

/** The two secrets, trimmed, or `null` unless both are set. */
function usageConfig(
  env: Pick<Env, "CF_ANALYTICS_TOKEN" | "CF_ACCOUNT_ID">,
): { token: string; accountId: string } | null {
  const token = env.CF_ANALYTICS_TOKEN?.trim() ?? "";
  const accountId = env.CF_ACCOUNT_ID?.trim() ?? "";
  if (!token) {
    return null;
  }
  if (!accountId) {
    if (!warnedAboutMissingAccount) {
      warnedAboutMissingAccount = true;
      console.warn(
        "usage: CF_ANALYTICS_TOKEN is set but CF_ACCOUNT_ID is not; the usage panel stays off",
      );
    }
    return null;
  }
  return { token, accountId };
}

/** How far back the storage window reaches: a day, whatever the hour. */
export const STORAGE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The query's windows: the UTC day, its start and its month's first day for
 * the counters, and the last 24 hours for storage.
 */
export function usageWindow(now: number) {
  const iso = new Date(now).toISOString();
  const day = iso.slice(0, 10);
  const monthStart = `${iso.slice(0, 7)}-01`;
  return {
    day,
    monthStart,
    variables: {
      day,
      dayStart: `${day}T00:00:00Z`,
      now: iso,
      monthStart: `${monthStart}T00:00:00Z`,
      storageSince: new Date(now - STORAGE_WINDOW_MS).toISOString(),
    },
  };
}

async function fetchUsage(
  { token, accountId }: { token: string; accountId: string },
  fetchImpl: typeof fetch,
  now: number,
): Promise<Outcome> {
  const window = usageWindow(now);

  let response: Response;
  try {
    response = await fetchImpl(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        query: USAGE_QUERY,
        variables: { account: accountId, ...window.variables },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    // Only the error's name: a message is free text.
    return failed("upstream", { request: errorName(error) });
  }

  if (response.status === 401 || response.status === 403) {
    return failed("unauthorized", { status: response.status });
  }
  if (response.status === 429) {
    return failed("rate_limited", { status: response.status });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failed("upstream", { status: response.status, body: "not JSON" });
  }

  const errors = graphqlErrors(body);
  if (errors.length > 0) {
    const codes = errors.map((error) => error.code ?? "none");
    return failed(classifyErrors(errors), { status: response.status, codes });
  }
  if (!response.ok) {
    return failed("upstream", { status: response.status });
  }

  const account = first(at(body, "data", "viewer", "accounts"));
  if (!isRecord(account)) {
    return failed("upstream", { status: response.status, body: "no account" });
  }

  return {
    status: "ok",
    report: buildReport(account, window.day, window.monthStart, new Date(now).toISOString()),
  };
}

/** The panel's figures, from the one account block of the answer. */
export function buildReport(
  account: Record<string, unknown>,
  day: string,
  monthStart: string,
  fetchedAt: string,
): UsageReport {
  // Both in microseconds.
  const cpuTimeUs = sumOf(account.doPeriodic, "sum", "cpuTime");
  const activeTimeUs = sumOf(account.doPeriodic, "sum", "activeTime");
  const r2Ops = r2Operations(account.r2Ops);

  return {
    configured: true,
    fetchedAt,
    day,
    monthStart,
    workers: {
      requests: sumOf(account.workers, "sum", "requests"),
      errors: sumOf(account.workers, "sum", "errors"),
      limit: FREE_TIER_LIMITS.workers,
    },
    d1: {
      rowsRead: sumOf(account.d1, "sum", "rowsRead"),
      rowsWritten: sumOf(account.d1, "sum", "rowsWritten"),
      limit: FREE_TIER_LIMITS.d1,
    },
    durableObjects: {
      requests: sumOf(account.doInvocations, "sum", "requests"),
      cpuTimeMs: cpuTimeUs === null ? null : cpuTimeUs / 1000,
      durationGbSeconds: activeTimeUs === null ? null : durationGbSeconds(activeTimeUs),
      limit: FREE_TIER_LIMITS.durableObjects,
    },
    r2: {
      ...r2Ops,
      storageBytes: r2StorageBytes(account.r2Storage),
      objectCount: sumOf(account.r2Storage, "max", "objectCount"),
      limit: FREE_TIER_LIMITS.r2,
    },
  };
}

/**
 * GB-s from microseconds of active (wall-clock) time: µs × 128 MB / (10⁶ µs/s
 * × 1000 MB/GB), multiplied first so that whole numbers stay exact.
 */
export function durationGbSeconds(activeTimeUs: number): number {
  return (activeTimeUs * DURABLE_OBJECT_MEMORY_MB) / 1e9;
}

/** R2 requests by class: an action of neither class, or a row without a count, is left out. */
function r2Operations(rows: unknown): { classA: number | null; classB: number | null } {
  if (!Array.isArray(rows)) {
    return { classA: null, classB: null };
  }

  let classA = 0;
  let classB = 0;
  for (const row of rows) {
    const action = at(row, "dimensions", "actionType");
    const requests = finite(at(row, "sum", "requests"));
    if (typeof action !== "string" || requests === null) {
      continue;
    }
    if (R2_CLASS_A_ACTIONS.has(action)) {
      classA += requests;
    } else if (R2_CLASS_B_ACTIONS.has(action)) {
      classB += requests;
    }
  }
  return { classA, classB };
}

/** Each bucket's peak payload and metadata over the last 24 hours, added up. */
function r2StorageBytes(rows: unknown): number | null {
  const payload = sumOf(rows, "max", "payloadSize");
  const metadata = sumOf(rows, "max", "metadataSize");
  return payload === null ? null : payload + (metadata ?? 0);
}

/**
 * A field added up over a dataset's rows: `0` for no rows, `null` when the
 * dataset is missing or no row carries the field as a number.
 */
function sumOf(rows: unknown, group: string, field: string): number | null {
  if (!Array.isArray(rows)) {
    return null;
  }
  if (rows.length === 0) {
    return 0;
  }

  const values = rows.map((row) => finite(at(row, group, field))).filter((v) => v !== null);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

interface GraphqlError {
  readonly code: string | null;
  readonly message: string;
}

function graphqlErrors(body: unknown): GraphqlError[] {
  const errors = at(body, "errors");
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.map((error) => {
    const code = at(error, "extensions", "code");
    const message = at(error, "message");
    return {
      code: typeof code === "string" ? code : null,
      message: typeof message === "string" ? message : "",
    };
  });
}

/**
 * `budget` is the API's rate limit
 * (developers.cloudflare.com/analytics/graphql-api/account-based-rate-limiting/,
 * "Rate limit errors"). A token without the permission, or for another
 * account, is `authz` ("not authorized for that account"); a token Cloudflare
 * does not know is an authentication error.
 */
function classifyErrors(errors: readonly GraphqlError[]): UsageFailure {
  if (errors.some((error) => error.code === "budget")) {
    return "rate_limited";
  }
  if (
    errors.some(
      (error) =>
        error.code === "authz" ||
        error.code === "authn" ||
        /authenticat|not authorized|unauthorized/i.test(error.message),
    )
  ) {
    return "unauthorized";
  }
  return "upstream";
}

/** Logs why there are no numbers, with nothing but a reason, a status and codes. */
function failed(reason: UsageFailure, detail: Record<string, unknown>): Outcome {
  console.warn(`usage: Cloudflare's GraphQL API gave no usage (${reason})`, detail);
  return { status: "unavailable", reason };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
