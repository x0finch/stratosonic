import { SELF } from "cloudflare:test";
import { ADMIN } from "./browsing-support";
import { BASE } from "./support";

/**
 * Calling the annotation write endpoints and reading their ok/failed envelope.
 *
 * These endpoints take repeatable parameters — several `id`s, or an `albumId`
 * and an `artistId` in one call — so the query is built by appending, which a
 * plain object cannot express; a value may be a string or a list of them.
 */

const PASSWORD = "sesame";

export interface WriteResponse {
  status: string;
  error?: { code: number; message: string };
}

export type Credentials = { readonly user: string; readonly password: string };

const ADMIN_CREDENTIALS: Credentials = { user: ADMIN, password: PASSWORD };

/** A query string with credentials, appending each value of a repeated key. */
export function writeQuery(
  extra: Record<string, string | readonly string[]>,
  credentials: Credentials = ADMIN_CREDENTIALS,
): string {
  const params = new URLSearchParams({
    u: credentials.user,
    p: credentials.password,
    v: "1.16.1",
    c: "Substreamer",
  });

  for (const [key, value] of Object.entries(extra)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      params.append(key, item as string);
    }
  }

  return params.toString();
}

/** Calls a write endpoint and reads the JSON envelope. */
export async function write(
  endpoint: string,
  extra: Record<string, string | readonly string[]> = {},
  credentials?: Credentials,
): Promise<WriteResponse> {
  const query = writeQuery({ ...extra, f: "json" }, credentials);
  const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${query}`);
  const body = (await response.json()) as { "subsonic-response": WriteResponse };

  return body["subsonic-response"];
}

/** Calls a write endpoint and reads the XML rendering, the default. */
export async function writeXml(
  endpoint: string,
  extra: Record<string, string | readonly string[]> = {},
): Promise<string> {
  return (await SELF.fetch(`${BASE}/rest/${endpoint}?${writeQuery(extra)}`)).text();
}
