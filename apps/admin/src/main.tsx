import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { ThemeProvider } from "@/components/theme-provider.tsx";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError, meQuery } from "@/lib/api";
import { routeTree } from "./routeTree.gen";

/**
 * A call the server refused for want of a session (it was revoked, or ran
 * out) signs the console out: the shell then shows the sign-in screen,
 * which returns to the same page (routes/_shell.tsx). That holds for a
 * write and for a read alike, such as the Overview's polls, which would
 * otherwise keep asking. `/api/me` itself answers no session as `null`,
 * not as an error.
 */
function signOutWhenUnauthenticated(error: unknown): void {
  if (error instanceof ApiError && error.code === "unauthenticated") {
    queryClient.setQueryData(meQuery.queryKey, null);
  }
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: signOutWhenUnauthenticated }),
  mutationCache: new MutationCache({ onError: signOutWhenUnauthenticated }),
});

const router = createRouter({ routeTree, context: { queryClient } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }

  interface StaticDataRouteOption {
    /** What the site header shows while the route is on screen. */
    title?: string;
  }
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("index.html has no #root element to render the console into");
}

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        {/* Above the router, so a toast outlives the navigation after it. */}
        <Toaster>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </Toaster>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
