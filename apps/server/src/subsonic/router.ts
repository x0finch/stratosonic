import type { Hono } from "hono";
import {
  type AuthenticatedUser,
  authenticate,
  checkRequiredParameters,
} from "../auth/authenticate";
import { recordLastAccess } from "../auth/last-access";
import type { Env } from "../env";
import {
  type ResponseFormat,
  renderSubsonicResponse,
  responseFormat,
  SubsonicError,
  SubsonicErrorCode,
  type SubsonicNode,
} from "./response";

export type SubsonicApp = Hono<{ Bindings: Env }>;

/** Everything a Subsonic handler is given. */
export interface SubsonicRequest {
  /** Query parameters, with a form-encoded POST body merged in. */
  readonly params: URLSearchParams;
  readonly env: Env;
  readonly raw: Request;
  /** Who is calling; `null` only on the endpoints mounted as public. */
  readonly user: AuthenticatedUser | null;
}

/** What an authenticated endpoint is given: the same request, with a user. */
export interface AuthenticatedSubsonicRequest extends SubsonicRequest {
  readonly user: AuthenticatedUser;
}

/** A handler returns the body of the envelope, or throws a `SubsonicError`. */
export type SubsonicHandler = (
  request: AuthenticatedSubsonicRequest,
) => SubsonicNode | Promise<SubsonicNode>;

/** A handler for an endpoint that is reachable without credentials. */
export type PublicSubsonicHandler = (
  request: SubsonicRequest,
) => SubsonicNode | Promise<SubsonicNode>;

/** How an endpoint is mounted. */
export interface EndpointOptions {
  /**
   * `true` mounts the endpoint without authentication and without the
   * required-parameter check, for the few endpoints the spec says a client may
   * reach before it has credentials.
   */
  readonly public?: boolean;
}

/**
 * Registers one endpoint the way Subsonic clients expect to find it: at both
 * `/rest/<name>` and `/rest/<name>.view`, over GET and POST. This is the only
 * place endpoints are mounted, so every endpoint gets both URL forms, both
 * methods, and the shared response rendering for free.
 */
export function registerEndpoint(
  app: SubsonicApp,
  name: string,
  handler: PublicSubsonicHandler,
  options: { readonly public: true },
): void;
export function registerEndpoint(
  app: SubsonicApp,
  name: string,
  handler: SubsonicHandler,
  options?: EndpointOptions,
): void;
export function registerEndpoint(
  app: SubsonicApp,
  name: string,
  handler: SubsonicHandler | PublicSubsonicHandler,
  options: EndpointOptions = {},
): void {
  app.on(["GET", "POST"], [`/rest/${name}`, `/rest/${name}.view`], async (c) => {
    const params = await readParams(c.req.raw);
    const format = responseFormat(params);

    try {
      const body = await callHandler(handler, options, {
        params,
        env: c.env,
        raw: c.req.raw,
        user: null,
      });
      return renderSubsonicResponse({ status: "ok", body }, format);
    } catch (error) {
      return renderFailure(error, format);
    }
  });
}

/**
 * Runs the handler, having first done whatever the endpoint is mounted with:
 * nothing for a public endpoint, and the required-parameter check followed by
 * authentication — in that order, as Navidrome does — for every other one.
 *
 * The two handler shapes differ only in whether `user` is known to be set, so
 * each branch narrows the request to the shape its handler expects.
 */
async function callHandler(
  handler: SubsonicHandler | PublicSubsonicHandler,
  options: EndpointOptions,
  request: SubsonicRequest,
): Promise<SubsonicNode> {
  if (options.public) {
    return (handler as PublicSubsonicHandler)(request);
  }

  checkRequiredParameters(request.params);
  const user = await authenticate(request.env, request.params);
  await recordLastAccess(request.env, user.id);

  return (handler as SubsonicHandler)({ ...request, user });
}

/**
 * Renders anything thrown outside an endpoint handler — by middleware, or by
 * Hono itself — as a Subsonic envelope, so a client never receives Hono's
 * default HTML 500.
 */
export function registerErrorHandler(app: SubsonicApp): void {
  app.onError(async (error, c) => {
    return renderFailure(error, responseFormat(await readParamsForErrorResponse(c.req.raw)));
  });
}

/**
 * Renders a thrown error as a failed envelope. A `SubsonicError` may ask for an
 * HTTP status of its own — the 501 the user-write endpoints answer with — and
 * everything else keeps the protocol's default of 200.
 */
function renderFailure(error: unknown, format: ResponseFormat): Response {
  const subsonicError = toSubsonicError(error);

  return renderSubsonicResponse(
    { status: "failed", error: subsonicError },
    format,
    subsonicError.httpStatus,
  );
}

/**
 * Like `readParams`, but tolerates a request body that has already been read:
 * whatever failed may have consumed it, and the format still has to be decided.
 */
async function readParamsForErrorResponse(request: Request): Promise<URLSearchParams> {
  try {
    return await readParams(request);
  } catch {
    return new URL(request.url).searchParams;
  }
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
    for (const [key, value] of await request.formData()) {
      if (typeof value === "string") {
        merged.append(key, value);
      }
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

  // An unexpected exception can carry internals a client has no business
  // seeing (SQL, bindings, stack text), so it goes to the log and the client
  // gets the generic Subsonic error instead.
  console.error(error);
  return new SubsonicError(SubsonicErrorCode.Generic);
}
