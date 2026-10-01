import type { ReactNode } from "react";

import { ErrorAlert } from "@/components/error-alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import type { ConfiguredUsage, UsageFigure } from "@/lib/api";
import { formatBytes, formatCount, formatPercent, formatRelative } from "@/lib/format";

/** What the panel writes for a figure Cloudflare's answer did not carry. */
const MISSING = "—";

const wholeCount = (value: number) => formatCount(Math.round(value));

/** A figure in words, or the dash for one Cloudflare's answer left out. */
function figure(value: UsageFigure, format: (value: number) => string = wholeCount): string {
  return value === null ? MISSING : format(value);
}

/**
 * Today's free-tier usage, from Cloudflare's GraphQL Analytics API through
 * `GET /api/usage` (#82, "API: usage panel"). The limits are per account, so
 * are the numbers: every Worker, database and bucket of the account, not
 * only this server's. Durable Objects are limited by requests and duration
 * on the free plan, not CPU, which is shown beside them for information. R2
 * is billed by the month, so its operations are month to date, and its
 * storage is each bucket's peak of the last 24 hours. A figure the answer
 * did not carry is a dash, not a guess.
 *
 * The Overview renders this only once the server has said it is configured,
 * so a server without an analytics token shows no panel and no error.
 */
export function UsagePanel({
  usage,
  error,
  now,
}: {
  usage: ConfiguredUsage | undefined;
  error: unknown;
  now: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Free-tier usage</CardTitle>
        <CardDescription>
          Today (UTC) for the whole Cloudflare account; R2 operations month to date.
          {usage ? ` Read from Cloudflare ${formatRelative(usage.fetchedAt, now)}.` : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error ? <ErrorAlert error={error} /> : null}
        {usage ? (
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            <Group title="Workers">
              <Meter
                label="Requests"
                value={usage.workers.requests}
                limit={usage.workers.limit.requests}
              />
              <Note>{figure(usage.workers.errors)} errors</Note>
            </Group>
            <Group title="D1">
              <Meter label="Rows read" value={usage.d1.rowsRead} limit={usage.d1.limit.rowsRead} />
              <Meter
                label="Rows written"
                value={usage.d1.rowsWritten}
                limit={usage.d1.limit.rowsWritten}
              />
            </Group>
            <Group title="Durable Objects">
              <Meter
                label="Requests"
                value={usage.durableObjects.requests}
                limit={usage.durableObjects.limit.requests}
              />
              <Meter
                label="Duration (GB-s)"
                value={usage.durableObjects.durationGbSeconds}
                limit={usage.durableObjects.limit.durationGbSeconds}
              />
              <Note>CPU time {figure(usage.durableObjects.cpuTimeMs)} ms, not limited</Note>
            </Group>
            <Group title="R2">
              <Meter
                label="Class A operations"
                value={usage.r2.classA}
                limit={usage.r2.limit.classA}
              />
              <Meter
                label="Class B operations"
                value={usage.r2.classB}
                limit={usage.r2.limit.classB}
              />
              <Meter
                label="Storage, 24-hour peak"
                value={usage.r2.storageBytes}
                limit={usage.r2.limit.storageBytes}
                format={formatBytes}
              />
              <Note>{figure(usage.r2.objectCount)} objects</Note>
            </Group>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/**
 * One figure against its limit, as a bar with the share beside it. A figure
 * the answer left out leaves the bar empty and says so with a dash.
 */
function Meter({
  label,
  value,
  limit,
  format = wholeCount,
}: {
  label: string;
  value: UsageFigure;
  limit: number;
  format?: (value: number) => string;
}) {
  const text = `${figure(value, format)} of ${format(limit)}`;
  const share = value === null ? MISSING : formatPercent(value, limit);

  return (
    <Progress
      value={value === null ? null : Math.min(value, limit)}
      max={limit}
      getAriaValueText={() => (value === null ? `${label}: unknown` : `${text}, ${share}`)}
      className="gap-1.5"
    >
      <ProgressLabel className="text-xs font-normal text-muted-foreground">{label}</ProgressLabel>
      <ProgressValue className="text-xs">{() => share}</ProgressValue>
      <span className="order-last w-full text-xs tabular-nums">{text}</span>
    </Progress>
  );
}
