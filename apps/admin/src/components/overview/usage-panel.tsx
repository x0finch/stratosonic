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
        // The layout follows the list's own width (a container query), not
        // the screen's, which the sidebar shares. Until the list is wide
        // enough for every lane (`@5xl`), a row takes two lines under its
        // service's name: the metric and its value, then the bar beside its
        // share, with two services side by side once there is room (`@3xl`),
        // so a metric never sits far from its value. From there, twelve columns are shared down to each row
        // (subgrid), with the service as a lane too, so every lane lines up
        // across the services.
        <div className="@container">
          <div className="grid gap-y-6 @3xl:grid-cols-2 @3xl:gap-x-10 @5xl:grid-cols-12 @5xl:gap-x-4">
            {groups.map((group) => (
              <Group key={group.service} group={group} />
            ))}
          </div>
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
      className="grid content-start gap-y-3 @5xl:col-span-full @5xl:grid-cols-subgrid @5xl:items-baseline"
    >
      <h3 id={id} className="text-sm font-medium @5xl:col-span-2">
        {group.service}
      </h3>
      <ul
        // A list styled without bullets, laid out as a flex or grid, loses
        // its semantics in Safari and VoiceOver unless its role is said again.
        // biome-ignore lint/a11y/noRedundantRoles: Safari drops a styled list's role.
        role="list"
        className="flex flex-col gap-y-4 @5xl:col-span-10 @5xl:grid @5xl:grid-cols-subgrid @5xl:gap-y-3"
      >
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
  // figures. On a narrow list each line is a flex row: the metric beside
  // its value, which never wraps, then the bar taking what the share's
  // narrow lane leaves, the same in every row. On a wide one both lines
  // dissolve (`contents`) into the shared lanes.
  return (
    <li className="flex flex-col gap-y-1.5 @5xl:col-span-full @5xl:grid @5xl:grid-cols-subgrid @5xl:items-center">
      <div className="flex items-baseline justify-between gap-3 @5xl:contents">
        <span className="min-w-0 @5xl:col-span-3">{metric.label}</span>
        <span className="shrink-0 text-right whitespace-nowrap tabular-nums @5xl:col-span-3">
          {text}
        </span>
      </div>
      <div className="flex items-center gap-3 @5xl:contents">
        <Progress
          aria-label={metric.name}
          value={value === null ? null : Math.min(value, limit)}
          max={limit}
          getAriaValueText={() => (value === null ? "unknown" : `${text}, ${share}`)}
          className="min-w-0 flex-1 @5xl:col-span-3"
        />
        <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums @5xl:w-auto">
          {share}
        </span>
      </div>
      {metric.note ? (
        <p className="text-xs text-muted-foreground @5xl:col-span-full">{metric.note}</p>
      ) : null}
    </li>
  );
}
