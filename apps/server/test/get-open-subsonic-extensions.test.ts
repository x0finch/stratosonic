import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "https://stratosonic.test";
/** What this server implements, in the order it lists them. */
const EXTENSIONS = [
  { name: "formPost", versions: [1] },
  { name: "songLyrics", versions: [1] },
];

const AUTH_QUERY = "u=admin&t=26719a1196d2a940705a59634eb18eab&s=c19b2d&v=1.16.1&c=Substreamer";

interface JsonEnvelope {
  "subsonic-response": {
    status: string;
    version: string;
    type: string;
    serverVersion: string;
    openSubsonic: boolean;
    openSubsonicExtensions?: { name: string; versions: number[] }[];
    error?: { code: number; message: string };
  };
}

describe("getOpenSubsonicExtensions", () => {
  it.each([
    ["bare path", "/rest/getOpenSubsonicExtensions"],
    [".view path", "/rest/getOpenSubsonicExtensions.view"],
  ])("answers on the %s", async (_label, path) => {
    const response = await SELF.fetch(`${BASE}${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");

    const xml = await response.text();
    expect(xml).toContain('<subsonic-response xmlns="http://subsonic.org/restapi" status="ok"');
    expect(xml).toContain(
      '<openSubsonicExtensions name="formPost"><versions>1</versions></openSubsonicExtensions>' +
        '<openSubsonicExtensions name="songLyrics"><versions>1</versions></openSubsonicExtensions>',
    );
  });

  it("carries the full envelope on the XML response", async () => {
    const xml = await (await SELF.fetch(`${BASE}/rest/getOpenSubsonicExtensions`)).text();

    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('status="ok"');
    expect(xml).toContain('version="1.16.1"');
    expect(xml).toContain('type="stratosonic"');
    expect(xml).toMatch(/serverVersion="\d+\.\d+\.\d+"/);
    expect(xml).toContain('openSubsonic="true"');
  });

  it("returns JSON for the same request when f=json", async () => {
    const response = await SELF.fetch(`${BASE}/rest/getOpenSubsonicExtensions?f=json`);

    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");

    const body = (await response.json()) as JsonEnvelope;
    expect(body["subsonic-response"]).toMatchObject({
      status: "ok",
      version: "1.16.1",
      type: "stratosonic",
      openSubsonic: true,
    });
    expect(body["subsonic-response"].serverVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body["subsonic-response"].openSubsonicExtensions).toEqual(EXTENSIONS);
  });

  it("does not require authentication", async () => {
    const body = (await (
      await SELF.fetch(`${BASE}/rest/getOpenSubsonicExtensions?f=json`)
    ).json()) as JsonEnvelope;

    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"].error).toBeUndefined();
  });

  it("tolerates authentication parameters being present", async () => {
    const body = (await (
      await SELF.fetch(`${BASE}/rest/getOpenSubsonicExtensions.view?${AUTH_QUERY}&f=json`)
    ).json()) as JsonEnvelope;

    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"].openSubsonicExtensions).toEqual(EXTENSIONS);
  });

  it("accepts parameters from a form-encoded POST body", async () => {
    const response = await SELF.fetch(`${BASE}/rest/getOpenSubsonicExtensions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ f: "json", c: "Substreamer" }).toString(),
    });

    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");

    const body = (await response.json()) as JsonEnvelope;
    expect(body["subsonic-response"].openSubsonicExtensions).toEqual(EXTENSIONS);
  });

  it("accepts a form-encoded POST body on the .view path too", async () => {
    const response = await SELF.fetch(`${BASE}/rest/getOpenSubsonicExtensions.view`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ c: "Substreamer" }).toString(),
    });

    await expect(response.text()).resolves.toContain('<openSubsonicExtensions name="formPost">');
  });
});
