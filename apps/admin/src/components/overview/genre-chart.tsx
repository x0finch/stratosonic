import { Bar, BarChart, LabelList, XAxis, YAxis } from "recharts";

import { Section } from "@/components/section";
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
    <Section
      title="Genres"
      description={
        genres !== undefined && genres.length > SHOWN
          ? `Tracks in the ${SHOWN} largest of ${formatCount(genres.length)} genres`
          : "Tracks by genre"
      }
    >
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
            // The focusable chart's name and description, as its svg's
            // <title> and <desc>; the arrow keys then step through the bars.
            title="Tracks by genre"
            desc={shown
              .map((genre) => `${genre.name}: ${formatCount(genre.songCount)} tracks`)
              .join(", ")}
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
              tickFormatter={(name: string) => (name.length > 16 ? `${name.slice(0, 15)}…` : name)}
            />
            <XAxis dataKey="songCount" type="number" hide />
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
            {/* The bars render still: the console adds no motion of its own (#128). */}
            <Bar
              dataKey="songCount"
              fill="var(--color-songCount)"
              radius={4}
              isAnimationActive={false}
            >
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
    </Section>
  );
}
