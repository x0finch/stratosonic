/**
 * The Subsonic response envelope and its two renderings.
 *
 * Handlers return a plain object tree; this module is the only place that knows
 * how that tree becomes bytes. XML is the default rendering and JSON is used
 * when the client sends `f=json` (ADR-0001).
 */

/** The protocol version Stratosonic implements. */
export const SUBSONIC_API_VERSION = "1.16.1";

/** The `type` attribute clients use to detect the server implementation. */
export const SERVER_TYPE = "stratosonic";

/** The `serverVersion` attribute. OpenSubsonic requires a strict `X.Y.Z`. */
export const SERVER_VERSION = "0.1.0";

const XML_NAMESPACE = "http://subsonic.org/restapi";

/**
 * The only error codes Stratosonic emits. Subsonic also defines 20, 30 and 60
 * (client/server too old, trial expired); none of them can occur here.
 */
export const SubsonicErrorCode = {
  Generic: 0,
  MissingParameter: 10,
  AuthenticationFailed: 40,
  NotAuthorized: 50,
  NotFound: 70,
} as const;

export type SubsonicErrorCode = (typeof SubsonicErrorCode)[keyof typeof SubsonicErrorCode];

/** Default messages, matching Navidrome's `responses.ErrorMsg`. */
const DEFAULT_ERROR_MESSAGES: Record<SubsonicErrorCode, string> = {
  [SubsonicErrorCode.Generic]: "A generic error",
  [SubsonicErrorCode.MissingParameter]: "Required parameter is missing",
  [SubsonicErrorCode.AuthenticationFailed]: "Wrong username or password",
  [SubsonicErrorCode.NotAuthorized]: "User is not authorized for the given operation",
  [SubsonicErrorCode.NotFound]: "The requested data was not found",
};

/** An error a handler can throw to produce a `status="failed"` response. */
export class SubsonicError extends Error {
  readonly code: SubsonicErrorCode;

  constructor(code: SubsonicErrorCode, message?: string) {
    super(message ?? DEFAULT_ERROR_MESSAGES[code]);
    this.name = "SubsonicError";
    this.code = code;
  }
}

/**
 * A value in the response body tree.
 *
 * Scalars become XML attributes, nested objects become child elements, and
 * arrays become one repeated child element per item — the same mapping
 * Navidrome gets from its Go struct tags.
 */
export type SubsonicValue = string | number | boolean | SubsonicNode | readonly SubsonicValue[];

export interface SubsonicNode {
  readonly [key: string]: SubsonicValue | undefined;
}

/** What a rendered response says: a successful body, or an error. */
export type SubsonicPayload =
  | { readonly status: "ok"; readonly body?: SubsonicNode }
  | { readonly status: "failed"; readonly error: SubsonicError };

export type ResponseFormat = "xml" | "json";

/** Clients ask for JSON with `f=json`; anything else gets XML (ADR-0001). */
export function responseFormat(params: URLSearchParams): ResponseFormat {
  return params.get("f") === "json" ? "json" : "xml";
}

/** HTTP status used unless a caller asks for another one. */
const DEFAULT_HTTP_STATUS = 200;

/**
 * Renders a payload as a complete HTTP response.
 *
 * Subsonic reports failures inside the envelope rather than through the HTTP
 * status, so the default is 200 — as Navidrome does. `httpStatus` overrides it
 * for the few endpoints that must say something at the HTTP level too, such as
 * the user-write endpoints Navidrome answers with 501 plus an error envelope.
 */
export function renderSubsonicResponse(
  payload: SubsonicPayload,
  format: ResponseFormat,
  httpStatus: number = DEFAULT_HTTP_STATUS,
): Response {
  const [body, contentType] =
    format === "json"
      ? [renderJson(payload), "application/json"]
      : [renderXml(payload), "application/xml"];

  return new Response(body, {
    status: httpStatus,
    headers: { "Content-Type": `${contentType}; charset=utf-8` },
  });
}

function envelopeAttributes(payload: SubsonicPayload): SubsonicNode {
  return {
    status: payload.status,
    version: SUBSONIC_API_VERSION,
    type: SERVER_TYPE,
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
  };
}

function payloadBody(payload: SubsonicPayload): SubsonicNode {
  if (payload.status === "failed") {
    return { error: { code: payload.error.code, message: payload.error.message } };
  }
  return payload.body ?? {};
}

function renderJson(payload: SubsonicPayload): string {
  return JSON.stringify({
    "subsonic-response": { ...envelopeAttributes(payload), ...payloadBody(payload) },
  });
}

function renderXml(payload: SubsonicPayload): string {
  const root = { xmlns: XML_NAMESPACE, ...envelopeAttributes(payload), ...payloadBody(payload) };

  return `<?xml version="1.0" encoding="UTF-8"?>${renderElement("subsonic-response", root)}`;
}

function renderElement(name: string, node: SubsonicNode): string {
  const attributes: string[] = [];
  const children: string[] = [];

  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      for (const item of value as readonly SubsonicValue[]) {
        children.push(renderChild(key, item));
      }
    } else if (isScalar(value)) {
      attributes.push(` ${key}="${escapeXmlAttribute(String(value))}"`);
    } else {
      children.push(renderElement(key, value as SubsonicNode));
    }
  }

  const openTag = `${name}${attributes.join("")}`;
  return children.length === 0 ? `<${openTag}/>` : `<${openTag}>${children.join("")}</${name}>`;
}

/** An array item is either a nested element or an element holding text. */
function renderChild(name: string, value: SubsonicValue): string {
  if (isScalar(value)) {
    return `<${name}>${escapeXmlText(String(value))}</${name}>`;
  }
  if (Array.isArray(value)) {
    return (value as readonly SubsonicValue[]).map((item) => renderChild(name, item)).join("");
  }
  return renderElement(name, value as SubsonicNode);
}

function isScalar(value: SubsonicValue): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
