import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { NOT_IMPLEMENTED_MESSAGE } from "../src/endpoints/not-implemented";
import { BASE, type JsonEnvelope, seedUser } from "./support";

/**
 * The account-management endpoints. They are registered, authenticated, and
 * answer HTTP 501 with a Subsonic error envelope — the status and message
 * Navidrome's `h501` uses.
 */

const USER = "editor";
const PASSWORD = "sesame";
const ENDPOINTS = ["createUser", "updateUser", "deleteUser", "changePassword"];

function query(extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    u: USER,
    p: PASSWORD,
    v: "1.16.1",
    c: "Substreamer",
    ...extra,
  }).toString();
}

beforeAll(async () => {
  await seedUser(USER, PASSWORD);
});

describe("user-write endpoints", () => {
  it.each(ENDPOINTS)("answers %s with HTTP 501 and an error envelope", async (name) => {
    const response = await SELF.fetch(`${BASE}/rest/${name}?${query({ username: "someone" })}`);
    const xml = await response.text();

    expect(response.status).toBe(501);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(xml).toContain('status="failed"');
    expect(xml).toContain(`<error code="0" message="${NOT_IMPLEMENTED_MESSAGE}"/>`);
  });

  it.each(ENDPOINTS)("answers %s the same way on the .view form", async (name) => {
    const response = await SELF.fetch(`${BASE}/rest/${name}.view?${query()}`);

    expect(response.status).toBe(501);
    await expect(response.text()).resolves.toContain('code="0"');
  });

  it("answers in JSON when the client asks for it", async () => {
    const response = await SELF.fetch(`${BASE}/rest/createUser?${query({ f: "json" })}`);
    const body = (await response.json()) as JsonEnvelope;

    expect(response.status).toBe(501);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(body["subsonic-response"]).toMatchObject({
      status: "failed",
      error: { code: 0, message: NOT_IMPLEMENTED_MESSAGE },
    });
  });

  it("accepts the parameters in a form-encoded POST body", async () => {
    const response = await SELF.fetch(`${BASE}/rest/changePassword`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: query({ f: "json" }),
    });
    const body = (await response.json()) as JsonEnvelope;

    expect(response.status).toBe(501);
    expect(body["subsonic-response"].error?.code).toBe(0);
  });

  it("is behind authentication, as in Navidrome", async () => {
    const response = await SELF.fetch(
      `${BASE}/rest/deleteUser?${query({ p: "open-sesame", f: "json" })}`,
    );
    const body = (await response.json()) as JsonEnvelope;

    // A failed login is a normal Subsonic failure, so it keeps HTTP 200.
    expect(response.status).toBe(200);
    expect(body["subsonic-response"]).toMatchObject({ status: "failed", error: { code: 40 } });
  });

  it("reports a missing required parameter before the endpoint answers", async () => {
    const parameters = new URLSearchParams(query({ f: "json" }));
    parameters.delete("c");

    const response = await SELF.fetch(`${BASE}/rest/createUser?${parameters}`);
    const body = (await response.json()) as JsonEnvelope;

    expect(response.status).toBe(200);
    expect(body["subsonic-response"].error?.code).toBe(10);
  });
});
