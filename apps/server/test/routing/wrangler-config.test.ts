import { describe, expect, it } from "vitest";
import { experimental_readRawConfig } from "wrangler";

/**
 * What wrangler.jsonc must keep consistent by hand. `R2_BUCKET_NAME` names
 * the bucket the presigned upload URLs point at (storage/presign.ts), and the
 * `MUSIC` binding does not expose its bucket's name, so the var repeats it:
 * if the two drift apart, the console browses one bucket and uploads into
 * another. Named environments inherit neither vars nor bindings, so each
 * environment is checked on its own.
 *
 * Read with Wrangler's own parser, in Node, as the deploy reads the file.
 */

interface RawEnvironment {
  readonly vars?: Record<string, unknown>;
  readonly r2_buckets?: readonly { readonly binding: string; readonly bucket_name?: string }[];
}

const { rawConfig } = experimental_readRawConfig({ config: "./wrangler.jsonc" });
const config = rawConfig as RawEnvironment & { readonly env?: Record<string, RawEnvironment> };

describe("wrangler.jsonc", () => {
  it.each([
    ["the top level", config],
    ["the preview environment", config.env?.preview],
  ])("in %s, names in R2_BUCKET_NAME the bucket MUSIC binds", (_, environment) => {
    const music = environment?.r2_buckets?.find((bucket) => bucket.binding === "MUSIC");

    expect(music?.bucket_name).toEqual(expect.any(String));
    expect(environment?.vars?.R2_BUCKET_NAME).toBe(music?.bucket_name);
  });
});
