/**
 * Where sign-in returns to. `/login?redirect=…` is a link anybody can send, so
 * its target must be a page of this console: a path on this origin, outside
 * the paths the Worker answers (apps/server/wrangler.jsonc,
 * `assets.run_worker_first`) and the sign-in and setup screens themselves.
 * Anything else goes to the overview.
 */

const WORKER_PATHS = ["/api", "/rest", "/share"];
const SIGNED_OUT_PATHS = ["/login", "/setup"];

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function safeRedirect(target: unknown, origin: string = window.location.origin): string {
  // Only a path: never a scheme or a protocol-relative `//host`.
  if (typeof target !== "string" || !target.startsWith("/")) {
    return "/";
  }

  let url: URL;
  try {
    url = new URL(target, origin);
  } catch {
    return "/";
  }

  // `/\host` and the like parse as another origin.
  if (url.origin !== origin) {
    return "/";
  }

  // Dot segments can leave a path that starts with `//` (`/.//host`,
  // `/a/..//host`), which the router would read as another origin.
  const path = url.pathname;
  if (path.startsWith("//")) {
    return "/";
  }
  if ([...WORKER_PATHS, ...SIGNED_OUT_PATHS].some((prefix) => isUnder(path, prefix))) {
    return "/";
  }

  return `${path}${url.search}${url.hash}`;
}
