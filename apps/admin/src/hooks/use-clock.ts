import { useEffect, useState } from "react";

/**
 * This browser's clock, read again every `intervalMs` (a minute by default),
 * so a relative time ("2 minutes ago") on a page that is not polled moves on
 * by itself. It reads nothing from the server.
 */
export function useClock(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
