import { createFileRoute } from "@tanstack/react-router";

import { NotFound } from "@/components/not-found";

// A path the console has no page for, shown inside the shell like any other
// page, once signed in. It names no title, so the header shows the console's.
export const Route = createFileRoute("/_shell/$")({
  component: NotFound,
});
