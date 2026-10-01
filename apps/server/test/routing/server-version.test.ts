import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { PINNED_ENV } from "../pinned-env";

/**
 * The release a deploy injects reaches every Subsonic response as
 * `serverVersion` (#101). The Worker is built the way the deploy workflow
 * builds it, `wrangler deploy --define`, only with `--dry-run`, and the test
 * harness runs that very bundle. The Workers pool cannot show this: it builds
 * the Worker itself, with nothing defined, so its tests see the fallback.
 */

const RELEASE = "9.8.7";

/** The two renderings' `serverVersion`, from the XML and the JSON envelope. */
async function serverVersions(
  fetch: (path: string) => Promise<{ text(): Promise<string> }>,
): Promise<[string | undefined, string | undefined]> {
  const query = "u=admin&p=sesame&v=1.16.1&c=test";
  const xml = await (await fetch(`/rest/ping?${query}`)).text();
  const json = JSON.parse(await (await fetch(`/rest/ping?${query}&f=json`)).text()) as {
    "subsonic-response": { status: string; serverVersion: string };
  };
  expect(json["subsonic-response"].status).toBe("ok");
  return [/ serverVersion="([^"]*)"/.exec(xml)?.[1], json["subsonic-response"].serverVersion];
}

describe("a Worker built with the release defined", () => {
  const outdir = mkdtempSync(join(tmpdir(), "stratosonic-release-"));
  const server = createTestHarness({
    workers: [
      {
        configPath: "./wrangler.jsonc",
        prebuiltWorkerDir: outdir,
        // Every secret and var pinned, so a local `.dev.vars` changes nothing.
        secrets: PINNED_ENV,
      },
    ],
  });

  beforeAll(async () => {
    execFileSync(
      "node_modules/.bin/wrangler",
      ["deploy", "--dry-run", "--outdir", outdir, "--define", `__SERVER_VERSION__:"${RELEASE}"`],
      { stdio: "pipe" },
    );
    await server.listen();
    await server.getWorker().applyD1Migrations("DB");
  });

  afterAll(async () => {
    await server.close();
    rmSync(outdir, { recursive: true, force: true });
  });

  it("reports that release in both renderings", async () => {
    expect(await serverVersions((path) => server.fetch(path))).toEqual([RELEASE, RELEASE]);
  });
});

describe("a Worker built with nothing defined", () => {
  const server = createTestHarness({
    workers: [
      {
        configPath: "./wrangler.jsonc",
        // Every secret and var pinned, so a local `.dev.vars` changes nothing.
        secrets: PINNED_ENV,
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

  it("reports the fixed fallback", async () => {
    expect(await serverVersions((path) => server.fetch(path))).toEqual(["0.0.0", "0.0.0"]);
  });
});
