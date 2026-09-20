import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { subsonicToken } from "../src/auth/crypto";
import { BASE, type JsonEnvelope, seedUser } from "./support";

const USER = "licensee";
const PASSWORD = "sesame";
const SALT = "c19b2d";

let query = "";

beforeAll(async () => {
  await seedUser(USER, PASSWORD);
  query = new URLSearchParams({
    u: USER,
    t: await subsonicToken(PASSWORD, SALT),
    s: SALT,
    v: "1.16.1",
    c: "Substreamer",
  }).toString();
});

describe("getLicense", () => {
  it.each(["/rest/getLicense", "/rest/getLicense.view"])(
    "reports a valid licence on %s",
    async (path) => {
      const xml = await (await SELF.fetch(`${BASE}${path}?${query}`)).text();

      expect(xml).toContain('status="ok"');
      expect(xml).toContain('<license valid="true"/>');
    },
  );

  it("reports it in JSON too", async () => {
    const body = (await (
      await SELF.fetch(`${BASE}/rest/getLicense?${query}&f=json`)
    ).json()) as JsonEnvelope;

    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"].license).toEqual({ valid: true });
  });

  it("is behind authentication", async () => {
    const body = (await (
      await SELF.fetch(`${BASE}/rest/getLicense?u=${USER}&p=wrong&v=1.16.1&c=Substreamer&f=json`)
    ).json()) as JsonEnvelope;

    expect(body["subsonic-response"]).toMatchObject({
      status: "failed",
      error: { code: 40 },
    });
    expect(body["subsonic-response"].license).toBeUndefined();
  });
});
