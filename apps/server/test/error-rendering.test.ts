import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubsonicError, SubsonicErrorCode } from "../src/subsonic/response";
import {
  registerEndpoint,
  registerErrorHandler,
  registerUnknownEndpointHandler,
  type SubsonicApp,
  type SubsonicHandler,
} from "../src/subsonic/router";

const LEAKY_MESSAGE = "D1_ERROR: no such table: secret_internals";

/** A throwaway app built exactly the way createApp() builds the real one. */
function appThatThrows(error: unknown, middleware = false): SubsonicApp {
  const app: SubsonicApp = new Hono();
  registerErrorHandler(app);

  if (middleware) {
    app.use("/rest/*", () => {
      throw error;
    });
  }

  const handler: SubsonicHandler = () => {
    if (middleware) return {};
    throw error;
  };

  registerEndpoint(app, "boom", handler);
  registerUnknownEndpointHandler(app);
  return app;
}

describe("error rendering", () => {
  let logged: unknown[];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not leak internal exception text to the client", async () => {
    const response = await appThatThrows(new Error(LEAKY_MESSAGE)).request("/rest/boom");
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(xml).not.toContain(LEAKY_MESSAGE);
    expect(xml).not.toContain("secret_internals");
    expect(xml).toContain('<error code="0" message="A generic error"/>');
  });

  it("logs the unexpected exception instead", async () => {
    const error = new Error(LEAKY_MESSAGE);
    await appThatThrows(error).request("/rest/boom");

    expect(logged).toContain(error);
  });

  it("passes a deliberate SubsonicError through unchanged", async () => {
    const error = new SubsonicError(SubsonicErrorCode.NotAuthorized);
    const xml = await (await appThatThrows(error).request("/rest/boom")).text();

    expect(xml).toContain(
      '<error code="50" message="User is not authorized for the given operation"/>',
    );
  });

  it("renders an exception thrown by middleware as a Subsonic envelope", async () => {
    const response = await appThatThrows(new Error(LEAKY_MESSAGE), true).request("/rest/boom");
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(xml).toContain('<subsonic-response xmlns="http://subsonic.org/restapi" status="failed"');
    expect(xml).toContain('<error code="0" message="A generic error"/>');
    expect(xml).not.toContain(LEAKY_MESSAGE);
  });

  it("honours f=json for an exception thrown by middleware", async () => {
    const response = await appThatThrows(new Error(LEAKY_MESSAGE), true).request(
      "/rest/boom?f=json",
    );
    const body = (await response.json()) as {
      "subsonic-response": { status: string; error: { code: number; message: string } };
    };

    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error).toEqual({ code: 0, message: "A generic error" });
  });

  it("honours f=json sent in a form-encoded POST body", async () => {
    const response = await appThatThrows(new Error(LEAKY_MESSAGE), true).request("/rest/boom", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ f: "json" }).toString(),
    });

    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });
});
