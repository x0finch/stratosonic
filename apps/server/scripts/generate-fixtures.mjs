/**
 * Writes the test fixtures and their manifest to `test/fixtures`.
 *
 * Run it with `pnpm --filter @stratosonic/server fixtures`. The bytes come from
 * `test/fixtures/build.ts`, which a test also calls, so regenerating the
 * fixtures either reproduces the committed files exactly or fails that test.
 *
 * `ffmpeg` is probed for and reported, but deliberately not used: its output
 * varies with the version, build and the timestamps it records, which would
 * make the fixtures irreproducible for the next person. The containers here are
 * assembled by hand instead - they are parseable, not playable, which is what
 * the extractor and the scanner are tested against.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixtures } from "../test/fixtures/build.ts";

const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

function probeFfmpeg() {
  try {
    const version = execFileSync("ffmpeg", ["-version"], { encoding: "utf8", stdio: "pipe" });
    return version.split("\n", 1)[0];
  } catch {
    return null;
  }
}

const ffmpeg = probeFfmpeg();
console.log(
  ffmpeg
    ? `ffmpeg found (${ffmpeg}); not used - the fixtures are assembled here so they stay byte-identical`
    : "ffmpeg not found; the fixtures are assembled here, which needs nothing on PATH",
);

const { files, manifest } = buildFixtures();

mkdirSync(directory, { recursive: true });

for (const file of files) {
  writeFileSync(join(directory, file.name), file.bytes);
  console.log(`wrote ${file.name} (${file.bytes.length} bytes)`);
}

writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log("wrote manifest.json");
