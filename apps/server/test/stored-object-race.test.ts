import { describe, expect, it } from "vitest";
import { serveStoredObject } from "../src/media/objects";
import { bindingStorage } from "../src/storage/binding";
import { testEnv } from "./support";

/**
 * An object rewritten shorter between the `head()` a response is built
 * from and the `get()` that reads it (media/objects.ts). The storage clamps
 * the read to the object's new end, so the bytes cannot fill the
 * `Content-Length` the head decided: the request fails rather than send a
 * 206 that promises bytes it does not carry.
 */

const KEY = "race/shrinks.flac";
const encoder = new TextEncoder();

async function shrunkAfterHead(range: string | null) {
  const storage = bindingStorage(testEnv);
  await storage.put(KEY, encoder.encode("0123456789"));
  const head = await storage.head(KEY);
  if (head === null) throw new Error("the object was not written");
  await storage.put(KEY, encoder.encode("0123"));

  const headers = range === null ? undefined : { Range: range };
  return serveStoredObject(storage, KEY, head, new Request("https://x/", { headers }), {
    contentType: "audio/flac",
  });
}

describe("serveStoredObject, when the object shrinks after its head", () => {
  it("fails a range that now starts past the end", async () => {
    await expect(shrunkAfterHead("bytes=6-9")).rejects.toThrow("changed size");
  });

  it("fails a range that now runs past the end", async () => {
    await expect(shrunkAfterHead("bytes=2-9")).rejects.toThrow("changed size");
  });

  it("fails a whole read", async () => {
    await expect(shrunkAfterHead(null)).rejects.toThrow("changed size");
  });

  it("serves a range the shorter object still holds", async () => {
    const response = await shrunkAfterHead("bytes=0-2");

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(await response.text()).toBe("012");
  });
});
