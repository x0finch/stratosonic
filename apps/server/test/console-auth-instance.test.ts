import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { runInitialSetup } from "../src/setup/initial-setup";
import { consoleRequest, countingD1 } from "./console-auth-support";
import { BASE, testEnv } from "./support";

/**
 * The console's Better Auth instance is built on the first `/api` request an
 * isolate serves, and only there (#89). The module is evaluated at startup
 * (console-auth/auth.ts says why), but the Subsonic API, the public image
 * URLs, the cron and the scan driver's alarm never build an instance, and
 * never read or write the auth tables, but for the cron's prune of their
 * expired rows (#93) and the first-run check, once per isolate, of whether an
 * owner exists (#99).
 *
 * `betterAuth()` is counted through a mock of `better-auth/minimal`, and every
 * D1 statement through a counting binding.
 */

const built = vi.hoisted(() => ({ count: 0 }));

vi.mock("better-auth/minimal", async (importOriginal) => {
  const real = await importOriginal<typeof import("better-auth/minimal")>();
  return {
    ...real,
    betterAuth: ((options) => {
      built.count++;
      return real.betterAuth(options);
    }) satisfies typeof real.betterAuth,
  };
});

/**
 * The tables only Better Auth and the console users' writer touch. `"user"`,
 * quoted, is the console's; the Subsonic table is `"subsonic_user"`.
 */
const AUTH_TABLES = /"(user|session|account|verification|rate_limit)"/;

const d1 = countingD1(testEnv.DB);
const env: Env = { ...testEnv, DB: d1.binding };

/**
 * The Worker, imported afresh: the pool loads its main module before this
 * file's mocks exist, to host the scan driver, so its `better-auth/minimal`
 * would not be the counted one. Resetting the module registry makes this
 * import load the whole Worker again, as a fresh isolate would.
 */
let fresh: Promise<typeof import("../src/index")> | undefined;
function freshWorker() {
  fresh ??= (() => {
    vi.resetModules();
    return import("../src/index");
  })();
  return fresh;
}

async function fetchThroughWorker(request: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await (await freshWorker()).default.fetch(
    request as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function authTableStatements(): string[] {
  return d1.statements.map((statement) => statement.sql).filter((sql) => AUTH_TABLES.test(sql));
}

beforeAll(async () => {
  // The first-run Subsonic admin is created up front, so the fresh isolate's
  // bootstrap below only checks.
  await runInitialSetup(testEnv);
  await freshWorker();
});

beforeEach(() => {
  d1.reset();
});

describe("the console's Better Auth instance", () => {
  it("is not built by loading the Worker", () => {
    expect(built.count).toBe(0);
  });

  it("is not built by an isolate's first request, whose bootstrap only asks if an owner exists", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await fetchThroughWorker(
      new Request(`${BASE}/rest/ping?u=admin&p=sesame&v=1.16.1&c=test&f=json`),
    );

    expect(await response.json()).toMatchObject({ "subsonic-response": { status: "ok" } });
    // One read, in the statement that reads the first-run flag
    // (setup/initial-setup.ts), and no write.
    const checks = d1.statements.filter((statement) => AUTH_TABLES.test(statement.sql));
    expect(checks.map((statement) => statement.sql)).toEqual([
      expect.stringMatching(
        /^select\s+exists \(select 1 from "property".*exists \(select 1 from "user" where "user"\."role" = \?\)/s,
      ),
    ]);
    expect(checks[0]?.rowsWritten).toBe(0);
    expect(built.count).toBe(0);
    vi.restoreAllMocks();
  });

  it("is not built by a Subsonic request, which leaves the auth tables alone", async () => {
    const response = await fetchThroughWorker(
      new Request(`${BASE}/rest/ping?u=admin&p=sesame&v=1.16.1&c=test&f=json`),
    );

    expect(await response.json()).toMatchObject({ "subsonic-response": { status: "ok" } });
    expect(d1.statements.length).toBeGreaterThan(0);
    expect(authTableStatements()).toEqual([]);
    expect(built.count).toBe(0);
  });

  it("is not built by a public image request", async () => {
    const response = await fetchThroughWorker(new Request(`${BASE}/share/img/not-a-token`));

    expect(response.status).toBe(400);
    expect(authTableStatements()).toEqual([]);
    expect(built.count).toBe(0);
  });

  it("is not built by the cron, which touches the auth tables only to prune them", async () => {
    const start = vi.fn(async () => "started" as const);
    const cronEnv = {
      ...env,
      SCAN_DRIVER: { idFromName: () => ({}), get: () => ({ start }) },
    } as unknown as Env;
    vi.spyOn(console, "log").mockImplementation(() => {});

    await (await freshWorker()).default.scheduled(createScheduledController(), cronEnv);

    expect(start).toHaveBeenCalledOnce();
    // The prune's three bounded deletes (console-auth/prune.ts), and nothing else.
    expect(authTableStatements().map((sql) => sql.match(/^delete from "(\w+)"/)?.[1])).toEqual([
      "session",
      "rate_limit",
      "verification",
    ]);
    expect(built.count).toBe(0);
  });

  it("is not built by the scan driver's alarm", async () => {
    // The driver's class from the fresh Worker, on the real object's storage:
    // a poke, then the step it schedules.
    const { ScanDriver } = await freshWorker();
    const stub = testEnv.SCAN_DRIVER.get(testEnv.SCAN_DRIVER.idFromName("library"));

    await runInDurableObject(stub, async (_instance, state) => {
      const driver = new ScanDriver(state, env);
      expect(await driver.start(Date.now())).toBe("started");
      await driver.alarm();
    });

    expect(d1.statements.length).toBeGreaterThan(0);
    expect(authTableStatements()).toEqual([]);
    expect(built.count).toBe(0);
  });

  it("is built by the first /api request, once for the isolate", async () => {
    expect((await fetchThroughWorker(consoleRequest(BASE, "/api/me"))).status).toBe(401);
    expect((await fetchThroughWorker(consoleRequest(BASE, "/api/me"))).status).toBe(401);

    expect(built.count).toBe(1);
  });
});
