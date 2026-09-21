import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin } from "./browsing-support";
import { search, searchXml } from "./search-support";

/**
 * Search against an empty library.
 *
 * A client searches before the first scan has populated anything, and an error
 * there can stop its sync (#9). Storage is isolated per test file, so this file
 * seeds no rows and asserts the empty, valid container both searches answer
 * with — the same rule the empty-library browsing and lists tests hold.
 */

beforeAll(async () => {
  await bootstrapAdmin();
});

describe("search on an empty library", () => {
  it.each(["search2", "search3"])("answers %s with an empty result, not an error", async (name) => {
    const body = await search(name, { query: "anything" });

    expect(body.status).toBe("ok");
    expect(body.error).toBeUndefined();
    expect(body.searchResult2 ?? body.searchResult3).toEqual({});
  });

  it("renders an empty search3 as a childless element", async () => {
    const xml = await searchXml("/rest/search3", { query: "anything" });

    expect(xml).toContain("<searchResult3/>");
    expect(xml).not.toContain("<error");
  });
});
