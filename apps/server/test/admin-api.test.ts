import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE } from "./support";

/**
 * `/api/*`, the admin console's JSON API (#87). An unknown path under it is a
 * JSON 404 — never the Subsonic envelope the rest of the Worker answers with.
 * Its routes have tests of their own (test/console-auth-*.test.ts), and which
 * paths reach the Worker at all is covered by test/routing.
 */
describe("the admin console API", () => {
  it.each([
    ["GET", "/api/nope"],
    ["GET", "/api/nested/nope?f=json"],
    ["POST", "/api/nope"],
    ["DELETE", "/api/nope"],
    ["GET", "/api"],
  ])("answers %s %s with a JSON 404", async (method, path) => {
    const response = await SELF.fetch(`${BASE}${path}`, { method });

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("leaves a path that only starts with /api to the rest of the Worker", async () => {
    const response = await SELF.fetch(`${BASE}/apiary`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  });
});
