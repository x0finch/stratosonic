/**
 * SPIKE #86 - what Better Auth adds to a Worker's startup: bundles the auth
 * stack alone (as wrangler would, `workerd` condition, minified) and times
 * parsing + evaluating it in fresh Node processes. Startup is billed against
 * the Worker's 1 s startup limit, not the 10 ms request CPU.
 *
 *   node scripts/bench-console-auth-startup.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const esbuild = require("../../../node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild");

const out = pathToFileURL(`${mkdtempSync(join(tmpdir(), "stratosonic-bench-"))}/`);
mkdirSync(out, { recursive: true });

const stacks = {
  // What the Worker already loads for routing and D1, for scale.
  "hono + drizzle-orm/d1 (already in the Worker)": `import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
globalThis.__keep = [Hono, drizzle];`,
  "better-auth/minimal + username plugin + drizzle adapter": `import { betterAuth } from "better-auth/minimal";
import { username } from "better-auth/plugins/username";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
globalThis.__keep = [betterAuth, username, drizzleAdapter];`,
};

const report = { node: process.version };
for (const [label, source] of Object.entries(stacks)) {
  const name = label.replace(/[^a-z]+/gi, "-").slice(0, 40);
  const entry = new URL(`${name}-entry.mjs`, out);
  const bundle = new URL(`${name}-bundle.mjs`, out);
  writeFileSync(entry, source);
  await esbuild.build({
    entryPoints: [entry.pathname],
    outfile: bundle.pathname,
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "import"],
    mainFields: ["module", "main"],
    external: ["node:*"],
    nodePaths: [new URL("../node_modules/", import.meta.url).pathname],
    logLevel: "error",
  });

  const runs = [];
  for (let index = 0; index < 15; index++) {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const t = performance.now(); await import(${JSON.stringify(bundle.href)}); console.log(performance.now() - t);`,
      ],
      { encoding: "utf8" },
    );
    runs.push(Number(output.trim()));
  }
  runs.sort((a, b) => a - b);
  report[label] = {
    bundleBytes: statSync(bundle).size,
    bundleGzipBytes: gzipSync(readFileSync(bundle)).length,
    importMsMedian: Number(runs[Math.floor(runs.length / 2)].toFixed(1)),
    importMsMin: Number(runs[0].toFixed(1)),
  };
}

console.log(JSON.stringify(report, null, 2));
