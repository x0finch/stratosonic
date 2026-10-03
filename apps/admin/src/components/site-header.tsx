import { useMatches } from "@tanstack/react-router";

import { ModeToggle } from "@/components/mode-toggle";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { UploadsPopover } from "@/components/uploads-popover";

/**
 * The breadcrumb's current page is the page's title, and so its level-one
 * heading, as the header's h1 was. BreadcrumbPage renders a disabled link; a
 * heading takes no aria-disabled, so that one is dropped.
 */
const PAGE_HEADING = { role: "heading", "aria-level": 1, "aria-disabled": undefined } as const;

/**
 * The sidebar-08 block's header: the sidebar trigger, a breadcrumb naming the
 * page, and the theme toggle at the other end, with the Uploads trigger
 * before it while the session's upload queue holds a file (#141).
 */
export function SiteHeader() {
  // The deepest route on screen that names itself; the not-found page names none.
  const title = useMatches({
    select: (matches) => matches.findLast((match) => match.staticData.title)?.staticData.title,
  });

  return (
    <header className="flex h-16 shrink-0 items-center gap-2">
      <div className="flex w-full items-center gap-2 px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mr-2 data-vertical:h-4 data-vertical:self-auto"
        />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage {...PAGE_HEADING}>{title ?? "Stratosonic"}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto flex items-center gap-2">
          <UploadsPopover />
          <ModeToggle />
        </div>
      </div>
    </header>
  );
}
