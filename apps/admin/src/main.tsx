import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { ThemeProvider } from "@/components/theme-provider.tsx";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { retryUnlessRefused } from "@/lib/api";
import { signOutWhenUnauthenticated } from "@/lib/sign-out";
import { routeTree } from "./routeTree.gen";

/**
 * A call the server refused for want of a session signs the console out
 * (lib/sign-out.ts). That holds for a write and for a read alike, such as
 * the Overview's polls, which would otherwise keep asking. `/api/me` itself
 * answers no session as `null`, not as an error.
 */
function onError(error: unknown): void {
  signOutWhenUnauthenticated(queryClient, error);
}

const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { retry: retryUnlessRefused } },
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
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
