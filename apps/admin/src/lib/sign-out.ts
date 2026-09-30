import type { QueryClient } from "@tanstack/react-query";

import { meQuery } from "@/lib/api";

/** The one navigation `leaveSignedOut` makes, so a test can stand in for the router. */
export interface SignOutNavigator {
  navigate(options: { to: "/login" }): Promise<void>;
}

/**
 * What the console does once the server has ended the session at the user's
 * request: nothing the user read stays in the cache for whoever signs in
 * next, and the visit goes to plain `/login`. A deliberate sign-out carries no
 * `?redirect`, so the next sign-in lands on the overview rather than on the
 * page that was left. The shell's guard, which does keep `?redirect`, is for
 * a visit that finds no session (routes/_shell.tsx).
 *
 * The session is recorded as gone before navigating, or the sign-in screen
 * would find the cached user still signed in and send the visit back.
 */
export async function leaveSignedOut(
  queryClient: QueryClient,
  router: SignOutNavigator,
): Promise<void> {
  queryClient.clear();
  queryClient.setQueryData(meQuery.queryKey, null);
  await router.navigate({ to: "/login" });
}
