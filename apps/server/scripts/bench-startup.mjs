/**
 * The Worker's startup CPU: what evaluating the bundle's global scope costs a
 * new isolate, against the 1 s startup limit (#81, "Free-tier budget").
 *
 *   pnpm --filter @stratosonic/server bench:startup [runs]
 *
 * Not part of the test suite or CI. It runs `wrangler check startup`, which
 * builds the Worker as `wrangler deploy` would and records a CPU profile of
 * its startup in a local workerd, `runs` times (9 by default), and prints the
 * median of the profile's active CPU time with the bundle size. The machine
 * is not Cloudflare's, so compare runs on one machine - a branch against
 * main, say - rather than reading the numbers as the edge's.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runs = Number(process.argv[2] ?? 9);
const profile = join(mkdtempSync(join(tmpdir(), "stratosonic-startup-")), "startup.cpuprofile");

const active = [];
let bundle = "";
for (let run = 0; run < runs; run++) {
  const output = execFileSync("wrangler", ["check", "startup", "--outfile", profile], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const measured = output.match(/Active: ([\d.]+) ms/);
  if (!measured) {
    throw new Error(`wrangler check startup printed no active time:\n${output}`);
  }
  active.push(Number(measured[1]));
  bundle = output.match(/Bundle: [^\n]+/)?.[0] ?? bundle;
}

active.sort((a, b) => a - b);
console.log(bundle);
console.log(
  `startup CPU over ${runs} runs: median ${active[Math.floor(runs / 2)]} ms, ` +
    `min ${active[0]} ms, max ${active.at(-1)} ms`,
);
