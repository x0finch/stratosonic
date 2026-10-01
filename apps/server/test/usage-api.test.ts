import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { forgetCachedUsage, GRAPHQL_ENDPOINT } from "../src/usage/analytics";
import {
  type CookieJar,
  consoleRequest,
  cost,
  countingD1,
  GUEST_ROLE,
  seedConsoleUser,
  signIn,
} from "./console-auth-support";
import sample from "./fixtures/cloudflare-usage-response.json";
import { testEnv } from "./support";

/**
 * `GET /api/usage` (#82, "API: usage panel"; #117): the console's free-tier
 * usage panel, for a console user whose role grants `usage:read`. The GraphQL
 * client itself is tested in usage-analytics.test.ts; here `fetch` is the
 * Worker's own, stood in for by a spy.
 */

const ORIGIN = "https://usage.stratosonic.test";
const TOKEN = "cf-analytics-token-route-0123456789";
const d1 = countingD1(testEnv.DB);
const unconfigured: Env = { ...testEnv, DB: d1.binding };
const configured: Env = {
  ...unconfigured,
  CF_ANALYTICS_TOKEN: TOKEN,
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
};
const app = createApp();

/** Cloudflare's rate-limit error. */
const BUDGET = { data: null, errors: [{ message: "", extensions: { code: "budget" } }] };

let owner: CookieJar;
let guest: CookieJar;

beforeAll(async () => {
  await seedConsoleUser("Olive", "orchard");
  await seedConsoleUser("Gus", "greenhouse", GUEST_ROLE);
  const send = (request: Request) => app.request(request, undefined, unconfigured);
  owner = (await signIn(send, ORIGIN, "olive", "orchard")).jar;
  guest = (await signIn(send, ORIGIN, "gus", "greenhouse")).jar;
});

beforeEach(() => {
  forgetCachedUsage();
  d1.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function getUsage(env: Env, jar?: CookieJar) {
  return app.request(consoleRequest(ORIGIN, "/api/usage", { jar }), undefined, env);
}

/** Stands in for the Worker's `fetch`, answering each call with `answer`. */
function stubFetch(answer: () => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
}

describe("GET /api/usage", () => {
  it("answers configured: false without the secrets, and calls nobody", async () => {
    const fetchSpy = stubFetch(() => Response.json(sample));

    const response = await getUsage(unconfigured, owner);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers today's usage with the secrets, from one GraphQL request", async () => {
    const fetchSpy = stubFetch(() => Response.json(sample));

    const response = await getUsage(configured, owner);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      configured: true,
      workers: { requests: 1234, errors: 2, limit: { requests: 100_000 } },
      d1: { rowsRead: 81234, rowsWritten: 412 },
      durableObjects: { requests: 840, cpuTimeMs: 51234, durationGbSeconds: 312.5 },
      r2: { classA: 1200, classB: 34000, storageBytes: 52_345_678_901, objectCount: 6100 },
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(GRAPHQL_ENDPOINT);
  });

  it("answers from the isolate's cache within 5 minutes", async () => {
    const fetchSpy = stubFetch(() => Response.json(sample));

    await getUsage(configured, owner);
    const again = await getUsage(configured, owner);

    expect(again.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["unauthorized", () => Response.json({}, { status: 403 })],
    ["rate_limited", () => Response.json(BUDGET)],
    ["upstream", () => new Response("bad gateway", { status: 502 })],
  ])(
    "answers 502 analytics_unavailable (%s) when Cloudflare gives none",
    async (reason, answer) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      stubFetch(answer);

      const response = await getUsage(configured, owner);

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "analytics_unavailable", reason });
    },
  );

  it("makes no D1 round trip, configured or not", async () => {
    stubFetch(() => Response.json(sample));

    for (const env of [unconfigured, configured]) {
      d1.reset();
      expect((await getUsage(env, owner)).status).toBe(200);
      expect(cost(d1.statements)).toMatchObject({ roundTrips: 0, rowsRead: 0, rowsWritten: 0 });
    }
  });

  it("answers 401 without a session, and calls nobody", async () => {
    const fetchSpy = stubFetch(() => Response.json(sample));

    const response = await getUsage(configured);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 403 forbidden to a role without usage:read, and calls nobody", async () => {
    const fetchSpy = stubFetch(() => Response.json(sample));

    const response = await getUsage(configured, guest);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
