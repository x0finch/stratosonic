import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import type { GenreCount } from "@/lib/api";
import { formatCount } from "@/lib/format";

/** How many genres the chart shows: the ones with the most tracks. */
const SHOWN = 10;

/** Each bar's height, so the chart grows with the genres it shows. */
const BAR_HEIGHT = 32;

const chartConfig = {
  songCount: { label: "Tracks", color: "var(--chart-2)" },
} satisfies ChartConfig;

/**
 * How the library divides by genre: the shadcn/ui horizontal bar chart, one
 * bar per genre, longest first. A library has dozens of genres, which no bar
 * chart can label legibly, so it shows the ten with the most tracks and says
 * how many there are.
 */
export function GenreChart({ genres }: { genres: GenreCount[] | undefined }) {
  const shown = genres
    ? [...genres].sort((a, b) => b.songCount - a.songCount).slice(0, SHOWN)
    : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Genres</CardTitle>
        <CardDescription>
          {genres === undefined
            ? "Tracks by genre"
            : genres.length > SHOWN
              ? `Tracks in the ${SHOWN} largest of ${formatCount(genres.length)} genres`
              : "Tracks by genre"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {shown === undefined ? (
          <Skeleton className="h-64 w-full" />
        ) : shown.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No genres</EmptyTitle>
              <EmptyDescription>None of the tracks scanned so far names a genre.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto w-full"
            style={{ height: shown.length * BAR_HEIGHT + 8 }}
          >
            <BarChart
              accessibilityLayer
              data={shown}
              layout="vertical"
              margin={{ left: 0, right: 48 }}
            >
              <YAxis
                dataKey="name"
                type="category"
                tickLine={false}
                axisLine={false}
                width={112}
                tickFormatter={(name: string) =>
                  name.length > 16 ? `${name.slice(0, 15)}…` : name
                }
              />
              <XAxis dataKey="songCount" type="number" hide />
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <Bar dataKey="songCount" fill="var(--color-songCount)" radius={4}>
                <LabelList
                  dataKey="songCount"
                  position="right"
                  offset={8}
                  className="fill-foreground"
                  fontSize={12}
                  formatter={(value) => (typeof value === "number" ? formatCount(value) : value)}
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
