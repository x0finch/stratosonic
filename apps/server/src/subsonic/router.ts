import type { Hono } from "hono";
import {
  renderSubsonicResponse,
  responseFormat,
  SubsonicError,
  SubsonicErrorCode,
  type SubsonicNode,
} from "./response";

export type SubsonicApp = Hono<{ Bindings: Cloudflare.Env }>;

/** Everything a Subsonic handler is given. */
export interface SubsonicRequest {
  /** Query parameters, with a form-encoded POST body merged in. */
  readonly params: URLSearchParams;
  readonly env: Cloudflare.Env;
  readonly raw: Request;
}

/** A handler returns the body of the envelope, or throws a `SubsonicError`. */
export type SubsonicHandler = (request: SubsonicRequest) => SubsonicNode | Promise<SubsonicNode>;

/**
 * Registers one endpoint the way Subsonic clients expect to find it: at both
 * `/rest/<name>` and `/rest/<name>.view`, over GET and POST. This is the only
 * place endpoints are mounted, so every endpoint gets both URL forms, both
 * methods, and the shared response rendering for free.
 */
export function registerEndpoint(app: SubsonicApp, name: string, handler: SubsonicHandler): void {
  app.on(["GET", "POST"], [`/rest/${name}`, `/rest/${name}.view`], async (c) => {
    const params = await readParams(c.req.raw);
    const format = responseFormat(params);

    try {
      const body = await handler({ params, env: c.env, raw: c.req.raw });
      return renderSubsonicResponse({ status: "ok", body }, format);
    } catch (error) {
      return renderSubsonicResponse({ status: "failed", error: toSubsonicError(error) }, format);
    }
  });
}

/**
 * Answers unknown `/rest/` endpoints inside the envelope rather than with a
 * bare HTTP 404, so a client's XML/JSON parser still sees a response it
 * understands. gonic answers the same way: error 70, "view not found".
 */
export function registerUnknownEndpointHandler(app: SubsonicApp): void {
  app.notFound(async (c) => {
    const { pathname } = new URL(c.req.url);
    if (!pathname.startsWith("/rest/")) {
      return c.text("Not Found", 404);
    }

    const params = await readParams(c.req.raw);
    return renderSubsonicResponse(
      { status: "failed", error: new SubsonicError(SubsonicErrorCode.NotFound, "view not found") },
      responseFormat(params),
    );
  });
}

/**
 * Merges a form-encoded POST body into the query parameters. Body values come
 * first so they take precedence, matching Go's `http.Request.ParseForm` and
 * therefore Navidrome's `postFormToQueryParams`.
 */
async function readParams(request: Request): Promise<URLSearchParams> {
  const merged = new URLSearchParams();
  const contentType = request.headers.get("Content-Type") ?? "";

  if (request.method === "POST" && contentType.includes("application/x-www-form-urlencoded")) {
    for (const [key, value] of new URLSearchParams(await request.text())) {
      merged.append(key, value);
    }
  }

  for (const [key, value] of new URL(request.url).searchParams) {
    merged.append(key, value);
  }

  return merged;
}

function toSubsonicError(error: unknown): SubsonicError {
  if (error instanceof SubsonicError) {
    return error;
  }

  const detail = error instanceof Error ? error.message : String(error);
  return new SubsonicError(SubsonicErrorCode.Generic, `Internal Server Error: ${detail}`);
}
