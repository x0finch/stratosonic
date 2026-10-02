import { useId } from "react";

import { ErrorAlert } from "@/components/error-alert";
import { RelativeTime } from "@/components/relative-time";
import { Section } from "@/components/section";
import { Progress } from "@/components/ui/progress";
import type { ConfiguredUsage } from "@/lib/api";
import { formatPercent, MISSING } from "@/lib/format";
import {
  describeClosest,
  type UsageGroup,
  type UsageMetric,
  usageGroups,
  usedOfLimit,
} from "@/lib/usage";

/**
 * Today's free-tier usage, from Cloudflare's GraphQL Analytics API through
 * `GET /api/usage` (#82, "API: usage panel"). The limits are per account, so
 * are the numbers: every Worker, database and bucket of the account, not
 * only this server's. R2 is billed by the month, so its operations are month
 * to date, and its storage is each bucket's peak of the last 24 hours. A
 * figure the answer did not carry is a dash, not a guess.
 *
 * One aligned list (#128): a row per metric, grouped by service, each with
 * the same lanes (the metric, its value of its limit, a bar of its share of
 * that limit, and the share), and a figure that qualifies a row, such as the
 * errors, as metadata under it. The description names the metric closest to
 * its limit, in words. Which rows there are, and that sentence, are
 * lib/usage.ts.
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
  const groups = usage ? usageGroups(usage) : undefined;
  const closest = groups ? describeClosest(groups) : "";

  return (
    <Section
      title="Free-tier usage"
      description={
        <>
          {closest ? `${closest} ` : null}
          Today (UTC) for the whole Cloudflare account; R2 operations month to date.
          {usage ? (
            <>
              {" "}
              Read from Cloudflare <RelativeTime iso={usage.fetchedAt} now={now} />.
            </>
          ) : null}
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      {groups ? (
        // One set of columns, shared down to each row (subgrid), so every
        // lane lines up across the services: twelve on a wide screen, where
        // the service is a lane too, and four on a narrow one, where a row
        // takes two lines (the metric and its value, then the bar and its
        // share) under its service's name.
        <div className="grid grid-cols-4 gap-x-3 gap-y-6 md:grid-cols-12 md:gap-x-4">
          {groups.map((group) => (
            <Group key={group.service} group={group} />
          ))}
        </div>
      ) : null}
    </Section>
  );
}

function Group({ group }: { group: UsageGroup }) {
  const id = useId();

  return (
    <section
      aria-labelledby={id}
      className="col-span-full grid grid-cols-subgrid items-baseline gap-y-3"
    >
      <h3 id={id} className="col-span-full text-sm font-medium md:col-span-2">
        {group.service}
      </h3>
      <ul className="col-span-full grid grid-cols-subgrid gap-y-4 md:col-span-10 md:gap-y-3">
        {group.metrics.map((metric) => (
          <Meter key={metric.label} metric={metric} />
        ))}
      </ul>
    </section>
  );
}

/**
 * One metric against its limit: its label, its value of the limit, a bar of
 * the share and the share, each in its lane, with its note beneath. A figure
 * the answer left out leaves the bar empty and says so with a dash. The bar
 * is named in full ("Workers requests"), not by the short label its group's
 * heading explains.
 */
function Meter({ metric }: { metric: UsageMetric }) {
  const { value, limit } = metric;
  const text = usedOfLimit(metric);
  const share = value === null ? MISSING : formatPercent(value, limit);

  // The label, the value and the share are each in their own lane, so the
  // bar alone is the progress bar, named in full and read out with its
  // figures.
  return (
    <li className="col-span-full grid grid-cols-subgrid items-center gap-y-1.5">
      <span className="col-span-2 min-w-0 md:col-span-3">{metric.label}</span>
      <span className="col-span-2 text-right whitespace-nowrap tabular-nums">{text}</span>
      <Progress
        aria-label={metric.name}
        value={value === null ? null : Math.min(value, limit)}
        max={limit}
        getAriaValueText={() => (value === null ? "unknown" : `${text}, ${share}`)}
        className="col-span-3 md:col-span-4"
      />
      <span className="text-right text-muted-foreground tabular-nums">{share}</span>
      {metric.note ? (
        <p className="col-span-full text-xs text-muted-foreground">{metric.note}</p>
      ) : null}
    </li>
  );
}
