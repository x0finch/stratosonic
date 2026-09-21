import { user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { registerEndpoint, type SubsonicApp } from "../src/subsonic/router";
import { BASE, seedUser, testEnv } from "./support";

/**
 * The registry's support for an endpoint that serves bytes.
 *
 * `stream`, `download` and `getCoverArt` answer with a file rather than an
 * envelope, and they are mounted through the same `registerEndpoint` as every
 * other endpoint so that they cannot miss the checks that come with it. These
 * tests exercise that support directly, with endpoints of their own, so what
 * the registry guarantees is stated once here instead of being inferred from
 * three endpoints' tests.
 */

const LISTENER = "byte-reader";
const PASSWORD = "sesame";

const BODY = "the bytes themselves";

let userId = "";

function credentials(): string {
  return new URLSearchParams({
    u: LISTENER,
    p: PASSWORD,
    v: "1.16.1",
    c: "Substreamer",
  }).toString();
}

/** An app carrying one endpoint that answers with a `Response` of its own. */
function appWithBinaryEndpoint(): SubsonicApp {
  const app: SubsonicApp = new Hono<{ Bindings: Env }>();

  registerEndpoint(
    app,
    "serveBytes",
    (request) =>
      new Response(request.raw.method === "HEAD" ? null : BODY, {
        status: 206,
        headers: { "Content-Type": "audio/flac", "X-Caller": request.user.userName },
      }),
  );

  return app;
}

async function call(app: SubsonicApp, path: string, init: RequestInit = {}): Promise<Response> {
  return await app.fetch(new Request(`${BASE}${path}`, init), testEnv);
}

/** The body as text, read as bytes so the runtime does not warn about it. */
async function bodyText(response: Response): Promise<string> {
  return new TextDecoder().decode(await response.arrayBuffer());
}

beforeAll(async () => {
  userId = await seedUser(LISTENER, PASSWORD);
});

describe("an endpoint that answers with bytes", () => {
  it.each(["/rest/serveBytes", "/rest/serveBytes.view"])(
    "sends the handler's own response untouched on %s",
    async (path) => {
      const response = await call(appWithBinaryEndpoint(), `${path}?${credentials()}`);

      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Type")).toBe("audio/flac");
      await expect(bodyText(response)).resolves.toBe(BODY);
    },
  );

  it("still reaches the handler with the authenticated user", async () => {
    const response = await call(appWithBinaryEndpoint(), `/rest/serveBytes?${credentials()}`);

    expect(response.headers.get("X-Caller")).toBe(LISTENER);
  });

  it("answers an anonymous caller with an error envelope rather than bytes", async () => {
    const response = await call(appWithBinaryEndpoint(), "/rest/serveBytes?u=nobody&v=1.16.1&c=x");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    await expect(response.text()).resolves.toContain('<error code="40"');
  });

  it("answers a caller missing a required parameter with error 10", async () => {
    const response = await call(appWithBinaryEndpoint(), `/rest/serveBytes?u=${LISTENER}`);

    await expect(response.text()).resolves.toContain('<error code="10"');
  });

  it("records the caller's last access, as every authenticated endpoint does", async () => {
    await call(appWithBinaryEndpoint(), `/rest/serveBytes?${credentials()}`);

    const rows = await database(testEnv).select().from(user).where(eq(user.id, userId));

    expect(rows[0]?.lastAccessAt).toBeInstanceOf(Date);
  });

  // Hono routes a HEAD request to the GET handler, so a player probing a
  // stream URL reaches the endpoint without it being mounted for HEAD.
  it("answers a HEAD request with the headers and no body", async () => {
    const response = await call(appWithBinaryEndpoint(), `/rest/serveBytes?${credentials()}`, {
      method: "HEAD",
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("audio/flac");
    await expect(bodyText(response)).resolves.toBe("");
  });
});
