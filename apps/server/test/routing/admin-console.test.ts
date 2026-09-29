import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";

/**
 * How a request is routed between the admin console's static assets and the
 * Worker (#87), over the real wrangler.jsonc, in both of its environments.
 *
 * `SELF` in the Workers pool is the Worker itself, with no asset router in
 * front of it, so it cannot show which of the two a path reaches. Wrangler's
 * test harness runs the Worker the way `wrangler dev` does, assets and all.
 *
 * Only `assets.run_worker_first` reaches the Worker; every other path is an
 * asset, and one that matches no file is the console's index.html (the
 * single-page-application fallback), so a deep link loads the console.
 */

// A browser marks a page load this way; the Worker's paths must reach the
// Worker even then, not the console.
const NAVIGATION = { headers: { "Sec-Fetch-Mode": "navigate" } };

/** The harness answers with Miniflare's `Response`, not the Workers one. */
type HarnessResponse = Awaited<ReturnType<ReturnType<typeof createTestHarness>["fetch"]>>;

async function expectConsole(response: HarnessResponse): Promise<void> {
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
  const html = await response.text();
  expect(html).toContain('<div id="root"></div>');
  expect(html).toContain("<title>Stratosonic</title>");
}

describe.each([
  ["the default environment", undefined],
  ["the preview environment", "preview"],
])("in %s", (_label, env) => {
  const server = createTestHarness({
    workers: [
      {
        configPath: "./wrangler.jsonc",
        env,
        secrets: {
          INITIAL_PASSWORD: "sesame",
          PASSWORD_ENCRYPTION_KEY: "test-password-encryption-key",
        },
      },
    ],
  });

  beforeAll(async () => {
    await server.listen();
    await server.getWorker().applyD1Migrations("DB");
  });

  afterAll(async () => {
    await server.close();
  });

  describe("the admin console", () => {
    it("is served at the root", async () => {
      await expectConsole(await server.fetch("/", NAVIGATION));
    });

    // Amperfy probes the bare server URL before it logs in, and treats a 404
    // as an unreachable server (see the root route in src/app.ts).
    it("answers a root probe that is not a navigation too", async () => {
      await expectConsole(await server.fetch("/"));
    });

    it("is served for a deep client route", async () => {
      await expectConsole(await server.fetch("/users", NAVIGATION));
    });
  });

  describe("the paths the Worker answers first", () => {
    it("keep /rest answering with the Subsonic envelope", async () => {
      const response = await server.fetch(
        "/rest/ping?u=admin&p=sesame&v=1.16.1&c=test&f=json",
        NAVIGATION,
      );
      const body = (await response.json()) as { "subsonic-response": { status: string } };

      expect(body["subsonic-response"].status).toBe("ok");
    });

    it("keep /share reaching the public image handler", async () => {
      const response = await server.fetch("/share/img/not-a-token", NAVIGATION);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("invalid request\n");
    });

    it("keep /api answering in JSON", async () => {
      const response = await server.fetch("/api/nope", NAVIGATION);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    });
  });
});
