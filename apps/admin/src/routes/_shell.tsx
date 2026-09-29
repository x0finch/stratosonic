import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { type CSSProperties, useEffect } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { NotFound } from "@/components/not-found";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { meQuery } from "@/lib/api";

/**
 * The signed-in console: every page under the sidebar shell. Without a
 * session a visit goes to `/login`, which returns here once signed in.
 */
export const Route = createFileRoute("/_shell")({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) {
      throw redirect({ to: "/login", search: { redirect: location.href }, replace: true });
    }
  },
  component: Shell,
  notFoundComponent: NotFound,
});

/** The dashboard-01 block's layout, with each route rendered where its content was. */
function Shell() {
  const { data: me } = useQuery(meQuery);
  const router = useRouter();

  // Signed out while on a page: by the sign-out action, or by a request the
  // server refused for want of a session (main.tsx). Reloading the route runs
  // the guard above, which sends the visit to /login and back here after.
  useEffect(() => {
    if (me === null) {
      void router.invalidate();
    }
  }, [me, router]);

  if (!me) {
    return null;
  }

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as CSSProperties
      }
    >
      <AppSidebar variant="inset" user={me} />
      <SidebarInset>
        <SiteHeader />
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-2">
            <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
              <Outlet />
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
