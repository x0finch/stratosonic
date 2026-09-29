import {
  createExecutionContext,
  createScheduledController,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { consoleRequest } from "./console-auth-support";
import { BASE, testEnv } from "./support";

/**
 * Better Auth is loaded lazily (#81, #89): evaluating its stack costs tens of
 * milliseconds of startup, so the Subsonic API, the public image URLs, the
 * cron and the scan driver's alarm must never evaluate it. Only an `/api`
 * request does, through the dynamic `import()` in console-auth/middleware.ts.
 *
 * A tripwire stands in for `better-auth/minimal`, which console-auth/auth.ts
 * imports first: Vitest calls a mock's factory when the module is first
 * imported, so the factory having run means Better Auth was evaluated. A
 * static import of console-auth/auth.ts anywhere in the Worker trips it in
 * every test but the last, which trips it on purpose.
 */

const tripwire = vi.hoisted(() => ({ evaluated: false }));

vi.mock("better-auth/minimal", async (importOriginal) => {
  tripwire.evaluated = true;
  return importOriginal();
});

/**
 * The Worker, imported afresh. The pool loads the Worker's main module before
 * this file's mocks exist, to host the scan driver, so an import of Better Auth
 * among the Worker's static imports would already be cached and evade the
 * tripwire. Resetting the module registry makes this import evaluate the
 * Worker's whole static graph again, with the tripwire in place, as a fresh
 * isolate would.
 */
let fresh: Promise<typeof import("../src/index")> | undefined;
function freshWorkerModule() {
  fresh ??= (() => {
    vi.resetModules();
    return import("../src/index");
  })();
  return fresh;
}

async function worker() {
  return (await freshWorkerModule()).default;
}

async function fetchThroughWorker(request: Request, env: Env = testEnv): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await (await worker()).fetch(
    request as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("Better Auth", () => {
  it("is not evaluated by loading the Worker", async () => {
    await worker();

    expect(tripwire.evaluated).toBe(false);
  });

  it("is not evaluated by a Subsonic request", async () => {
    const response = await fetchThroughWorker(
      new Request(`${BASE}/rest/ping?u=admin&p=sesame&v=1.16.1&c=test&f=json`),
    );

    expect(await response.json()).toMatchObject({ "subsonic-response": { status: "ok" } });
    expect(tripwire.evaluated).toBe(false);
  });

  it("is not evaluated by a public image request", async () => {
    const response = await fetchThroughWorker(new Request(`${BASE}/share/img/not-a-token`));

    expect(response.status).toBe(400);
    expect(tripwire.evaluated).toBe(false);
  });

  it("is not evaluated by the cron", async () => {
    const start = vi.fn(async () => "started" as const);
    const env = {
      ...testEnv,
      SCAN_DRIVER: { idFromName: () => ({}), get: () => ({ start }) },
    } as unknown as Env;
    vi.spyOn(console, "log").mockImplementation(() => {});

    await (await worker()).scheduled(createScheduledController(), env);

    expect(start).toHaveBeenCalledOnce();
    expect(tripwire.evaluated).toBe(false);
  });

  it("is not evaluated by the scan driver's alarm", async () => {
    // The driver's class from the fresh graph, run on the real object's
    // storage: a poke, then the alarm step it schedules.
    const { ScanDriver } = await freshWorkerModule();
    const stub = testEnv.SCAN_DRIVER.get(testEnv.SCAN_DRIVER.idFromName("library"));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runInDurableObject(stub, async (_instance, state) => {
      const driver = new ScanDriver(state, testEnv);
      expect(await driver.start(Date.now())).toBe("started");
      await driver.alarm();
    });

    expect(tripwire.evaluated).toBe(false);
  });

  it("is evaluated by the first /api request", async () => {
    const response = await fetchThroughWorker(consoleRequest(BASE, "/api/me"));

    expect(response.status).toBe(401);
    expect(tripwire.evaluated).toBe(true);
  }, 30_000);
});
