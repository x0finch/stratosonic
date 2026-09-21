import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE } from "./support";

/**
 * The bare server URL has to answer, even though the API lives under `/rest/`.
 *
 * A client checks the root is reachable before it authenticates — Amperfy's
 * `checkServerReachablity` does a plain GET of the root and treats any status
 * >= 400 (except 401) as "server unreachable" — so a 404 at `/` blocks login
 * before the first `ping`. The root must answer under 400.
 */
describe("the root path", () => {
  it("answers a reachability probe with 200, not 404", async () => {
    const response = await SELF.fetch(`${BASE}/`);
    expect(response.status).toBe(200);
    await response.text();
  });

  it("answers a HEAD probe under 400 as well", async () => {
    const response = await SELF.fetch(`${BASE}/`, { method: "HEAD" });
    expect(response.status).toBeLessThan(400);
    await response.body?.cancel();
  });

  it("still 404s an unknown non-/rest path", async () => {
    const response = await SELF.fetch(`${BASE}/favicon.ico`);
    expect(response.status).toBe(404);
    await response.text();
  });

  it("still answers an unknown /rest endpoint with an error envelope, not 404", async () => {
    const response = await SELF.fetch(`${BASE}/rest/nope?f=json`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { "subsonic-response": { status: string } };
    expect(body["subsonic-response"].status).toBe("failed");
  });
});
