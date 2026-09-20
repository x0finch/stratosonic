import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { subsonicToken } from "../src/auth/crypto";
import { BASE, type JsonEnvelope, seedUser } from "./support";

const USER = "Tester";
const PASSWORD = "sesame";
const SALT = "c19b2d";

/** The credentials a client sends, as a query string. */
async function credentials(overrides: Record<string, string> = {}): Promise<string> {
  return new URLSearchParams({
    u: USER,
    t: await subsonicToken(PASSWORD, SALT),
    s: SALT,
    v: "1.16.1",
    c: "Substreamer",
    f: "json",
    ...overrides,
  }).toString();
}

async function ping(query: string): Promise<JsonEnvelope["subsonic-response"]> {
  const response = await SELF.fetch(`${BASE}/rest/ping?${query}`);
  const body = (await response.json()) as JsonEnvelope;

  return body["subsonic-response"];
}

beforeAll(async () => {
  await seedUser(USER, PASSWORD);
});

describe("token authentication", () => {
  it("accepts a valid token", async () => {
    expect(await ping(await credentials())).toMatchObject({ status: "ok", version: "1.16.1" });
  });

  it("answers on both URL forms and in XML by default", async () => {
    const query = await credentials({ f: "xml" });

    for (const path of ["/rest/ping", "/rest/ping.view"]) {
      const response = await SELF.fetch(`${BASE}${path}?${query}`);

      expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
      await expect(response.text()).resolves.toContain('status="ok"');
    }
  });

  it("accepts credentials from a form-encoded POST body", async () => {
    const response = await SELF.fetch(`${BASE}/rest/ping.view`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: await credentials(),
    });
    const body = (await response.json()) as JsonEnvelope;

    expect(body["subsonic-response"].status).toBe("ok");
  });

  it("compares the token in lowercase", async () => {
    const token = (await subsonicToken(PASSWORD, SALT)).toUpperCase();

    expect(await ping(await credentials({ t: token }))).toMatchObject({ status: "ok" });
  });

  it("rejects a token built from the wrong password", async () => {
    const token = await subsonicToken("open-sesame", SALT);

    expect(await ping(await credentials({ t: token }))).toMatchObject({
      status: "failed",
      error: { code: 40, message: "Wrong username or password" },
    });
  });

  it("rejects a token computed with another salt", async () => {
    const token = await subsonicToken(PASSWORD, "another-salt");

    expect(await ping(await credentials({ t: token }))).toMatchObject({
      status: "failed",
      error: { code: 40 },
    });
  });

  it("accepts a one-character salt, since the protocol sets no minimum", async () => {
    const token = await subsonicToken(PASSWORD, "x");

    expect(await ping(await credentials({ t: token, s: "x" }))).toMatchObject({ status: "ok" });
  });

  it("rejects an unknown user with the same error as a wrong password", async () => {
    expect(await ping(await credentials({ u: "nobody" }))).toMatchObject({
      status: "failed",
      error: { code: 40, message: "Wrong username or password" },
    });
  });

  it("rejects a request carrying no credentials at all", async () => {
    const query = new URLSearchParams({ u: USER, v: "1.16.1", c: "Substreamer", f: "json" });

    expect(await ping(query.toString())).toMatchObject({ status: "failed", error: { code: 40 } });
  });

  it.each([
    ["exactly", USER],
    ["in lowercase", USER.toLowerCase()],
    ["in uppercase", USER.toUpperCase()],
  ])("matches the username given %s", async (_label, userName) => {
    expect(await ping(await credentials({ u: userName }))).toMatchObject({ status: "ok" });
  });
});

describe("password authentication", () => {
  it("accepts the plaintext p parameter", async () => {
    const query = await credentials({ p: PASSWORD, t: "", s: "" });

    expect(await ping(query)).toMatchObject({ status: "ok" });
  });

  it("accepts the hex-encoded enc: form", async () => {
    const hex = [...PASSWORD].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    const query = await credentials({ p: `enc:${hex}`, t: "", s: "" });

    expect(await ping(query)).toMatchObject({ status: "ok" });
  });

  it("rejects a wrong plaintext password", async () => {
    expect(await ping(await credentials({ p: "open-sesame", t: "" }))).toMatchObject({
      status: "failed",
      error: { code: 40 },
    });
  });

  it("takes p over t when a client sends both", async () => {
    const query = await credentials({ p: "open-sesame" });

    expect(await ping(query)).toMatchObject({ status: "failed", error: { code: 40 } });
  });
});

describe("required parameters", () => {
  it.each(["u", "v", "c"])("rejects a request missing %s", async (missing) => {
    const query = new URLSearchParams(await credentials());
    query.delete(missing);

    expect(await ping(query.toString())).toMatchObject({
      status: "failed",
      error: { code: 10, message: `missing parameter: '${missing}'` },
    });
  });

  it("reports a missing parameter before it looks at the credentials", async () => {
    const query = new URLSearchParams(await credentials({ t: "wrong" }));
    query.delete("c");

    expect(await ping(query.toString())).toMatchObject({ error: { code: 10 } });
  });

  it("does not require them on the public endpoint", async () => {
    const response = await SELF.fetch(`${BASE}/rest/getOpenSubsonicExtensions?f=json`);
    const body = (await response.json()) as JsonEnvelope;

    expect(body["subsonic-response"].status).toBe("ok");
  });
});
