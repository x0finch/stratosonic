import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { limitJsonBody, MAX_JSON_BODY_BYTES, readJsonObject } from "../src/api/json-body";
import { requireSameOrigin } from "../src/api/same-origin";

/**
 * The guards on the console's own writes (#81): the cross-site request check
 * every state-changing `/api` route outside Better Auth goes behind, and the
 * cap on a JSON body.
 */

const ORIGIN = "https://console.stratosonic.test";

const app = new Hono()
  .post("/write", requireSameOrigin, (c) => c.json({ ok: true }))
  .post("/form", limitJsonBody, async (c) => c.json({ body: await readJsonObject(c) }));

function post(path: string, headers: Record<string, string>, body = "{}") {
  return app.request(`${ORIGIN}${path}`, { method: "POST", headers, body });
}

describe("requireSameOrigin", () => {
  it("lets a same-origin JSON request through", async () => {
    const response = await post("/write", { origin: ORIGIN, "content-type": "application/json" });

    expect(response.status).toBe(200);
  });

  it("accepts JSON with parameters, in any case, and Sec-Fetch-Site: same-origin", async () => {
    const response = await post("/write", {
      origin: ORIGIN,
      "content-type": "Application/JSON; charset=utf-8",
      "sec-fetch-site": "same-origin",
    });

    expect(response.status).toBe(200);
  });

  it.each([
    ["no Origin", { "content-type": "application/json" }],
    ["another origin", { origin: "https://evil.example", "content-type": "application/json" }],
    ["another port", { origin: `${ORIGIN}:8443`, "content-type": "application/json" }],
    [
      "plain http",
      { origin: "http://console.stratosonic.test", "content-type": "application/json" },
    ],
    ["an opaque origin", { origin: "null", "content-type": "application/json" }],
    [
      "Sec-Fetch-Site: cross-site",
      { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "cross-site" },
    ],
    [
      "Sec-Fetch-Site: same-site",
      { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-site" },
    ],
    ["no Content-Type", { origin: ORIGIN }],
    ["a form", { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }],
    ["multipart", { origin: ORIGIN, "content-type": "multipart/form-data; boundary=x" }],
    ["text/plain", { origin: ORIGIN, "content-type": "text/plain" }],
  ])("refuses a request with %s", async (_, headers: Record<string, string>) => {
    const response = await post("/write", headers);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
  });
});

describe("limitJsonBody and readJsonObject", () => {
  it("read a JSON object", async () => {
    const response = await post("/form", { "content-type": "application/json" }, '{"a":"b"}');

    expect(await response.json()).toEqual({ body: { a: "b" } });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["null", "null"],
  ])("answer null for %s", async (_, body) => {
    const response = await post("/form", { "content-type": "application/json" }, body);

    expect(await response.json()).toEqual({ body: null });
  });

  it("refuse a body over the cap with 413", async () => {
    const body = JSON.stringify({ a: "x".repeat(MAX_JSON_BODY_BYTES) });
    const response = await post("/form", { "content-type": "application/json" }, body);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large" });
  });

  it("refuse a body over the cap that has no Content-Length", async () => {
    const chunk = new TextEncoder().encode("x".repeat(MAX_JSON_BODY_BYTES + 1));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await app.request(`${ORIGIN}/form`, {
      method: "POST",
      headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      body,
      duplex: "half",
    } as RequestInit);

    expect(response.status).toBe(413);
  });
});
