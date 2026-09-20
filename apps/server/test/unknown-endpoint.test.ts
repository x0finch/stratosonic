import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("unknown endpoints", () => {
  it("answers an unknown /rest endpoint inside the envelope", async () => {
    const response = await SELF.fetch("https://stratosonic.test/rest/noSuchEndpoint");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    await expect(response.text()).resolves.toContain('<error code="70" message="view not found"/>');
  });

  it("answers an unknown /rest endpoint as JSON when f=json", async () => {
    const response = await SELF.fetch("https://stratosonic.test/rest/noSuchEndpoint.view?f=json");
    const body = (await response.json()) as {
      "subsonic-response": { status: string; error: { code: number; message: string } };
    };

    expect(body["subsonic-response"].status).toBe("failed");
    expect(body["subsonic-response"].error).toEqual({ code: 70, message: "view not found" });
  });

  it("leaves non-Subsonic paths as a plain 404", async () => {
    const response = await SELF.fetch("https://stratosonic.test/not-the-api");

    expect(response.status).toBe(404);
  });
});
