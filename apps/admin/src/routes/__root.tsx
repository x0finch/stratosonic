import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import { ErrorScreen } from "@/components/error-screen";
import { NotFound } from "@/components/not-found";

export interface RouterContext {
  queryClient: QueryClient;
}

/**
 * Two layouts hang off the root: the sidebar shell (`_shell`), for signed-in
 * pages, and the full-screen sign-in and setup screens, which render bare as
 * the login-01 block does.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  errorComponent: ErrorScreen,
  notFoundComponent: NotFound,
});
