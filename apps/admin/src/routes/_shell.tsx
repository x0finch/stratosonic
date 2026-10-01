import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { NotFound } from "@/components/not-found";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { meQuery } from "@/lib/api";

/**
 * The signed-in console: every page under the sidebar shell. A visit without
 * a session (it ran out, or a deep link opened while signed out) goes to
 * `/login`, which returns here once signed in. Signing out on purpose does
 * not come through here: it goes to plain `/login` (lib/sign-out.ts).
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

/**
 * The sidebar-08 block's layout, with each route rendered where its content
 * was, in one centered column: every page gets the block's padding and the
 * same width, which fills the content area on a laptop and stops at
 * `max-w-7xl` on a wider screen (#107).
 *
 * The shell is one viewport tall and never scrolls itself: the sidebar and
 * the header stay put, and a page taller than the screen scrolls inside the
 * inset, below the header, whose rounded corners clip it.
 */
function Shell() {
  const { data: me } = useQuery(meQuery);
  const router = useRouter();

  // Signed out while on a page by a request the server refused for want of a
  // session (main.tsx). Reloading the route runs the guard above, which sends
  // the visit to /login and back here after. The sign-out action navigates to
  // plain /login itself (lib/sign-out.ts) before this can run, so the reload
  // it may still trigger reloads /login, not this page.
  useEffect(() => {
    if (me === null) {
      void router.invalidate();
    }
  }, [me, router]);

  if (!me) {
    return null;
  }

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar user={me} />
      <SidebarInset className="min-h-0 overflow-hidden">
        <SiteHeader />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-4 pt-0">
            <Outlet />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
