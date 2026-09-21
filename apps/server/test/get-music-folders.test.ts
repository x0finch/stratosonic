import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN, bootstrapAdmin, browse, browseXml, query } from "./browsing-support";
import { BASE, type JsonEnvelope } from "./support";

/**
 * `getMusicFolders`: the list a folder-browsing client reads first, and whose
 * ids it sends back as `musicFolderId`.
 *
 * Nothing is seeded here on purpose. The folder exists because the server
 * serves one bucket, not because the library has anything in it, so an empty
 * library must still be offered a folder to browse.
 */

beforeAll(async () => {
  await bootstrapAdmin();
});

describe("getMusicFolders", () => {
  it.each(["/rest/getMusicFolders", "/rest/getMusicFolders.view"])(
    "answers on %s with the one folder",
    async (path) => {
      const xml = await browseXml(path);

      expect(xml).toContain('status="ok"');
      expect(xml).toContain(
        '<musicFolders><musicFolder id="1" name="Music Library"/></musicFolders>',
      );
    },
  );

  it("lists exactly one folder, with the id getUser reports", async () => {
    const body = await browse("getMusicFolders");

    expect(body.status).toBe("ok");
    expect(body.musicFolders?.musicFolder).toEqual([{ id: 1, name: "Music Library" }]);
  });

  it("offers the folder getUser already told the client it has", async () => {
    const [folder] = (await browse("getMusicFolders")).musicFolders?.musicFolder ?? [];

    const response = await SELF.fetch(
      `${BASE}/rest/getUser?${query({ username: ADMIN, f: "json" })}`,
    );
    const body = (await response.json()) as JsonEnvelope;

    expect(body["subsonic-response"].user?.folder).toEqual([folder?.id]);
  });
});
