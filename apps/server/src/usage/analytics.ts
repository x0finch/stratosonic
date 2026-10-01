import type { Env } from "../env";

/**
 * The console's free-tier usage panel (#82, "API: usage panel"): today's
 * usage of the whole Cloudflare account, read from Cloudflare's GraphQL
 * Analytics API with a read-only token, next to the free plan's limits.
 *
 * The free-tier limits are per account, so the numbers are account-wide
 * totals, not filtered by script, database or bucket. A refresh is two small
 * `POST`s, at most two subrequests: `USAGE_QUERY`, every dataset in one query,
 * and, once that has answered, `ACTIVE_TIME_QUERY` for the one field
 * Cloudflare's docs do not name. The result is cached in the isolate, never in
 * D1 (which would write a row per refresh) nor in the Cache API (inert on
 * `workers.dev`, ADR-0004).
 *
 * The token is only ever sent to Cloudflare: what the console gets is numbers,
 * and what the log gets is a reason, an HTTP status, error codes and error
 * paths.
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
 * The main query, with only the datasets, fields and filter operators that
 * Cloudflare's docs show: the Workers metrics tutorial
 * (`workersInvocationsAdaptive`, `datetime_geq`/`_leq`), the D1 metrics page
 * (`d1AnalyticsAdaptiveGroups`, `date_geq`/`_leq`, `rowsRead`, `rowsWritten`),
 * the Durable Objects metrics page (`date_gt`, `sum.requests`,
 * `sum.cpuTime`) and the R2 metrics page. A field the schema rejects fails a
 * whole GraphQL query, so nothing unverified goes in here.
 *
 * Groups without dimensions add up the whole filter, so one row comes back
 * for each of those; R2 groups by action type and by bucket (an account on
 * the free plan may have up to 1,000 buckets).
 *
 * The counters cover today (UTC): `date_gt: $yesterday` is today, since no
 * day after it has data yet. R2's operations cover the month to date. Storage
 * is a level, not a counter, so it covers the last 24 hours instead: a window
 * from midnight would hold no sample just after 00:00 UTC, and read as an
 * empty account.
 */
export const USAGE_QUERY = `query Usage($account: string!, $day: Date!, $yesterday: Date!, $dayStart: Time!, $now: Time!, $monthStart: Time!, $storageSince: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workers: workersInvocationsAdaptive(limit: 1, filter: { datetime_geq: $dayStart, datetime_leq: $now }) {
      sum { requests errors }
    }
    d1: d1AnalyticsAdaptiveGroups(limit: 1, filter: { date_geq: $day, date_leq: $day }) {
      sum { rowsRead rowsWritten }
    }
    doInvocations: durableObjectsInvocationsAdaptiveGroups(limit: 1, filter: { date_gt: $yesterday }) {
      sum { requests }
    }
    doPeriodic: durableObjectsPeriodicGroups(limit: 1, filter: { date_gt: $yesterday }) {
      sum { cpuTime }
    }
    r2Ops: r2OperationsAdaptiveGroups(limit: 100, filter: { datetime_geq: $monthStart, datetime_leq: $now }) {
      sum { requests } dimensions { actionType }
    }
    r2Storage: r2StorageAdaptiveGroups(limit: 1000, filter: { datetime_geq: $storageSince, datetime_leq: $now }) {
      max { payloadSize metadataSize objectCount } dimensions { bucketName }
    }
  } }
}`;

/**
 * Today's Durable Object active (wall-clock) time, in microseconds, which
 * the duration limit is measured in. `durableObjectsPeriodicGroups.sum.
 * activeTime` is the one field the panel needs that no Cloudflare page names
 * (the Durable Objects metrics page leaves it to introspection), so it is
 * asked for on its own: if the guess is wrong, only `durationGbSeconds` is
 * `null`, and the rest of the panel stands.
 */
export const ACTIVE_TIME_QUERY = `query DurableObjectActiveTime($account: string!, $yesterday: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    doPeriodic: durableObjectsPeriodicGroups(limit: 1, filter: { date_gt: $yesterday }) {
      sum { activeTime }
    }
  } }
}`;

/**
 * What the panel shows. A figure missing from the answer is `null` rather
 * than a guess, and a dataset with no rows is `0`: nothing was used. A field
 * the schema rejects would fail its whole query instead, so the only
 * unverified field is isolated in its own request (`ACTIVE_TIME_QUERY`).
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

/** How long each GraphQL request may take before it counts as `upstream`. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The isolate's last outcome. Only a resolved value is kept, never a promise
 * shared across requests, as in setup/initial-setup.ts: a request awaiting
 * I/O begun by another request's context can be cancelled out from under it.
 * Several requests, or several isolates, may therefore each refresh once. A
 * refresh counts as at most seven queries (six datasets, then one), far below
 * the API's 300 per 5 minutes.
 */
let cached: { accountId: string; value: Outcome; expiresAt: number } | null = null;

/** Whether this isolate has reported a token without an account id. */
let warnedAboutMissingAccount = false;

/** Whether this isolate has reported that the active-time query failed. */
let warnedAboutActiveTime = false;

export interface UsageDependencies {
  /** The `fetch` the GraphQL request goes through. */
  readonly fetch: typeof fetch;
  /** The clock, in epoch milliseconds. */
  readonly now?: () => number;
}

/**
 * The usage panel's answer: `unconfigured` without both secrets (and nothing
 * fetched), otherwise the cached outcome while it lasts, and a fresh one
 * fetched with `USAGE_QUERY`, then `ACTIVE_TIME_QUERY`, when it does not.
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

/** Forgets the cached outcome, and what this isolate has warned about. For tests. */
export function forgetCachedUsage(): void {
  cached = null;
  warnedAboutActiveTime = false;
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
 * The queries' windows: the UTC day, the day before it, the day's start and
 * its month's first day for the counters, and the last 24 hours for storage.
 */
export function usageWindow(now: number) {
  const iso = new Date(now).toISOString();
  const day = iso.slice(0, 10);
  const monthStart = `${iso.slice(0, 7)}-01`;
  const yesterday = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  return {
    day,
    monthStart,
    variables: {
      day,
      yesterday,
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
  const ask = (query: string, variables: Record<string, string>) =>
    postQuery(fetchImpl, token, query, { account: accountId, ...variables });

  const usage = await ask(USAGE_QUERY, window.variables);
  if (!usage.ok) {
    console.warn(`usage: Cloudflare's GraphQL API gave no usage (${usage.reason})`, usage.detail);
    return { status: "unavailable", reason: usage.reason };
  }

  // Asked only once the main query has answered, so a failed refresh costs one
  // subrequest, and whatever this one answers, the panel keeps its figures.
  const activeTime = await ask(ACTIVE_TIME_QUERY, { yesterday: window.variables.yesterday });
  let activeTimeUs: number | null = null;
  if (activeTime.ok) {
    activeTimeUs = sumOf(activeTime.account.doPeriodic, "sum", "activeTime");
  } else if (!warnedAboutActiveTime) {
    warnedAboutActiveTime = true;
    console.warn(
      `usage: the Durable Object active-time query failed (${activeTime.reason}); the duration is left out`,
      activeTime.detail,
    );
  }

  return {
    status: "ok",
    report: buildReport(
      usage.account,
      activeTimeUs,
      window.day,
      window.monthStart,
      new Date(now).toISOString(),
    ),
  };
}

type QueryResult =
  | { readonly ok: true; readonly account: Record<string, unknown> }
  | { readonly ok: false; readonly reason: UsageFailure; readonly detail: Record<string, unknown> };

/**
 * Sends one GraphQL query and returns its one account block, or why there is
 * none, with what may be logged about it: an HTTP status, error codes and
 * error paths, never a message, which is free text.
 */
async function postQuery(
  fetchImpl: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, string>,
): Promise<QueryResult> {
  const failure = (reason: UsageFailure, detail: Record<string, unknown>): QueryResult => ({
    ok: false,
    reason,
    detail,
  });

  let response: Response;
  try {
    response = await fetchImpl(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return failure("upstream", { request: errorName(error) });
  }

  if (response.status === 429) {
    await discard(response);
    return failure("rate_limited", { status: response.status });
  }
  if (response.status === 401 || response.status === 403) {
    // Read only for its error codes and paths, which say whether the token was
    // refused or one dataset is out of the account's reach.
    const errors = graphqlErrors(await response.json().catch(() => null));
    return failure("unauthorized", { status: response.status, ...describeErrors(errors) });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failure("upstream", { status: response.status, body: "not JSON" });
  }

  const errors = graphqlErrors(body);
  if (errors.length > 0) {
    return failure(classifyErrors(errors), {
      status: response.status,
      ...describeErrors(errors),
    });
  }
  if (!response.ok) {
    return failure("upstream", { status: response.status });
  }

  const account = first(at(body, "data", "viewer", "accounts"));
  if (!isRecord(account)) {
    return failure("upstream", { status: response.status, body: "no account" });
  }
  return { ok: true, account };
}

/** Lets go of a body that is not read. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing is left to release.
  }
}

/** The panel's figures, from the main query's account block and the active time. */
export function buildReport(
  account: Record<string, unknown>,
  activeTimeUs: number | null,
  day: string,
  monthStart: string,
  fetchedAt: string,
): UsageReport {
  // In microseconds, as `activeTime` is.
  const cpuTimeUs = sumOf(account.doPeriodic, "sum", "cpuTime");
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
  /** Where in the query it arose, e.g. `viewer/accounts/0/r2Storage`. */
  readonly path: string | null;
}

function graphqlErrors(body: unknown): GraphqlError[] {
  const errors = at(body, "errors");
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.map((error) => {
    const code = at(error, "extensions", "code");
    const message = at(error, "message");
    const path = at(error, "path");
    return {
      code: typeof code === "string" ? code : null,
      message: typeof message === "string" ? message : "",
      path:
        Array.isArray(path) && path.every((part) => ["string", "number"].includes(typeof part))
          ? path.join("/")
          : null,
    };
  });
}

/** What the log may say about the errors: their codes and paths. */
function describeErrors(errors: readonly GraphqlError[]): Record<string, unknown> {
  return {
    codes: errors.map((error) => error.code ?? "none"),
    paths: errors.map((error) => error.path ?? "none"),
  };
}

/**
 * `budget` is the API's rate limit
 * (developers.cloudflare.com/analytics/graphql-api/account-based-rate-limiting/,
 * "Rate limit errors"). A token without the permission, or for another
 * account, is `authz` ("not authorized for that account"); a token Cloudflare
 * does not know is an authentication error. A dataset the account cannot
 * query ("does not have access to the path") is refused the same way, and
 * fails the whole query: the logged error path tells the two apart.
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
