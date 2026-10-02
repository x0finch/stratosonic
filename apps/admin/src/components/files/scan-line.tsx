import { Badge } from "@/components/ui/badge";
import { useClock } from "@/hooks/use-clock";
import { type ScanView, scanLine } from "@/lib/files";

/** How often the line counts down: well inside its one-minute steps. */
const TICK_MS = 5_000;

/**
 * The scan line (#83, "Layout", item 2): while a pass is scheduled or
 * running, a badge for its state and one muted sentence, such as "Library
 * scan in about 2 minutes.". The region is always there, empty and so hidden
 * otherwise, so that a screen reader hears the line when it appears.
 */
export function ScanLine({ view }: { view: ScanView | undefined }) {
  return (
    <div aria-live="polite" className="empty:hidden">
      {view === undefined ? null : <ScanLineText view={view} />}
    </div>
  );
}

function ScanLineText({ view }: { view: ScanView }) {
  const now = useClock(TICK_MS);
  const line = scanLine(view, now);
  if (line === null) {
    return null;
  }

  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <Badge variant="outline">{line.badge}</Badge>
      <span className="min-w-0">{line.text}</span>
    </p>
  );
}
