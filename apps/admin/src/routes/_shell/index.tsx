import { createFileRoute } from "@tanstack/react-router";
import { LayoutDashboardIcon } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export const Route = createFileRoute("/_shell/")({
  component: Overview,
  staticData: { title: "Overview" },
});

function Overview() {
  return (
    <div className="px-4 lg:px-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LayoutDashboardIcon />
          </EmptyMedia>
          <EmptyTitle>Nothing here yet</EmptyTitle>
          <EmptyDescription>
            The overview of the library and its scans will appear here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
