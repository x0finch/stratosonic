import { playlistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin } from "./browsing-support";
import {
  callPlaylists,
  importUntilComplete,
  type PlaylistCaller,
  playlistObjects,
  playlists,
  type SubsonicPlaylistElement,
  storedEntries,
  storedPlaylists,
} from "./playlists-support";
import { seedAlbum, seedArtist, seedPlaylist, seedTrack, seedUser, testEnv } from "./support";

/**
 * The two write endpoints, as a client uses them: a playlist is created, read
 * back, found in the bucket as an `.m3u`, left alone by the next import, and
 * then deleted from both places.
 *
 * Everything is asserted over HTTP except the bucket itself, which is read
 * directly because no endpoint serves an `.m3u`, and the two rows the sweep
 * test seeds, which exist to stand for a state a pass cannot produce on
 * demand.
 */

const KEYS = [
  "Silent Artist/Quiet Album/01 One.mp3",
  "Silent Artist/Quiet Album/02 Two.mp3",
  "Silent Artist/Quiet Album/03 Three.mp3",
];

const SONG_IDS = KEYS.map((key) => prefixedId("track", trackId(key)));

const LISTENER: PlaylistCaller = { user: "listener", password: "hunter2" };

/** A playlist a test created, and the file it left behind. */
let mix: SubsonicPlaylistElement;
let mixKey: string;

/** The `.m3u` of a playlist this file created, by the playlist's client id. */
async function fileOf(id: string): Promise<{ key: string; text: string } | null> {
  for (const [key, text] of await playlistObjects()) {
    if (prefixedId("playlist", playlistId(key)) === id) {
      return { key, text };
    }
  }

  return null;
}

/** A pass that begins now, which is after everything R2 has stamped. */
function passTime(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedUser(LISTENER.user, LISTENER.password);

  await seedArtist({ name: "Silent Artist" });
  const album = await seedAlbum({
    name: "Quiet Album",
    albumArtist: "Silent Artist",
    year: 2001,
  });
  for (const [index, key] of KEYS.entries()) {
    await seedTrack({
      r2Key: key,
      album: album.name,
      albumArtist: "Silent Artist",
      year: 2001,
      trackNumber: index + 1,
      duration: 100 + index,
    });
  }
});

describe("createPlaylist", () => {
  it("answers with the new playlist and its songs, in the order they were sent", async () => {
    const response = await callPlaylists("createPlaylist", [
      ["name", "Mix"],
      ["songId", SONG_IDS[1] ?? ""],
      ["songId", SONG_IDS[0] ?? ""],
    ]);

    expect(response.status).toBe("ok");
    mix = response.playlist as SubsonicPlaylistElement;
    expect(mix.name).toBe("Mix");
    expect(mix.songCount).toBe(2);
    expect(mix.duration).toBe(201);
    expect(mix.owner).toBe("admin");
    expect(mix.entry?.map((entry) => entry.id)).toEqual([SONG_IDS[1], SONG_IDS[0]]);
  });

  it("is listed by getPlaylists and returned by getPlaylist", async () => {
    const listed = (await playlists("getPlaylists")).playlists?.playlist ?? [];
    const read = await playlists("getPlaylist", { id: mix.id });

    expect(listed.map((entry) => entry.id)).toContain(mix.id);
    expect(read.playlist?.entry?.map((entry) => entry.id)).toEqual([SONG_IDS[1], SONG_IDS[0]]);
  });

  it("left an .m3u in the bucket, under playlists/ and not named after the playlist", async () => {
    const file = await fileOf(mix.id);
    mixKey = file?.key ?? "";

    expect(mixKey).toMatch(/^playlists\/[0-9a-zA-Z]{22}\.m3u$/);
    expect(mixKey).not.toContain("Mix");
    expect(file?.text).toBe(`#EXTM3U\n#PLAYLIST:Mix\n${KEYS[1]}\n${KEYS[0]}\n`);
  });

  it("dates the playlist by the object it wrote, as an import would", async () => {
    const uploaded = (await testEnv.MUSIC.head(mixKey))?.uploaded;

    expect(uploaded).toBeTruthy();
    expect(mix.created).toBe(uploaded?.toISOString());
    expect(mix.changed).toBe(uploaded?.toISOString());
  });

  it("keeps a song the client listed twice", async () => {
    const response = await callPlaylists("createPlaylist", [
      ["name", "Twice"],
      ["songId", SONG_IDS[0] ?? ""],
      ["songId", SONG_IDS[0] ?? ""],
    ]);

    expect(response.playlist?.songCount).toBe(2);
    expect(response.playlist?.entry?.map((entry) => entry.id)).toEqual([SONG_IDS[0], SONG_IDS[0]]);
  });

  it("makes a second playlist of the same name rather than overwriting the first", async () => {
    const other = await callPlaylists("createPlaylist", [["name", "Mix"]]);
    const listed = (await playlists("getPlaylists")).playlists?.playlist ?? [];

    expect(other.playlist?.id).not.toBe(mix.id);
    expect((await fileOf(other.playlist?.id ?? ""))?.key).not.toBe(mixKey);
    expect(listed.filter((entry) => entry.name === "Mix")).toHaveLength(2);
  });
});

describe("the import that follows a client's write", () => {
  it("changes nothing at all: same rows, same answer", async () => {
    const before = {
      rows: await storedPlaylists(),
      entries: await storedEntries(),
      read: await playlists("getPlaylist", { id: mix.id }),
    };

    const runs = await importUntilComplete({}, passTime(1));

    expect(runs.at(-1)?.completed).toBe(true);
    expect(runs.at(-1)?.totals.removed).toBe(0);
    expect(await storedPlaylists()).toEqual(before.rows);
    expect(await storedEntries()).toEqual(before.entries);
    expect(await playlists("getPlaylist", { id: mix.id })).toEqual(before.read);
  });
});

describe("createPlaylist with a playlistId", () => {
  it("replaces the songs, keeping the playlist's id, name and created", async () => {
    const response = await callPlaylists("createPlaylist", [
      ["playlistId", mix.id],
      ["songId", SONG_IDS[2] ?? ""],
    ]);

    expect(response.playlist?.id).toBe(mix.id);
    expect(response.playlist?.name).toBe("Mix");
    expect(response.playlist?.created).toBe(mix.created);
    expect(response.playlist?.entry?.map((entry) => entry.id)).toEqual([SONG_IDS[2]]);
  });

  it("rewrote the same file rather than leaving a second one", async () => {
    const file = await fileOf(mix.id);

    expect(file?.key).toBe(mixKey);
    expect(file?.text).toBe(`#EXTM3U\n#PLAYLIST:Mix\n${KEYS[2]}\n`);
  });

  it("moved `changed` to the file's new upload time", async () => {
    const uploaded = (await testEnv.MUSIC.head(mixKey))?.uploaded;
    const read = await playlists("getPlaylist", { id: mix.id });

    expect(read.playlist?.changed).toBe(uploaded?.toISOString());
  });

  it("refuses a playlist the caller does not own with error 50", async () => {
    const refused = await callPlaylists(
      "createPlaylist",
      [
        ["playlistId", mix.id],
        ["songId", SONG_IDS[0] ?? ""],
      ],
      LISTENER,
    );

    expect(refused.error?.code).toBe(50);
    expect((await playlists("getPlaylist", { id: mix.id })).playlist?.songCount).toBe(1);
  });
});

describe("deletePlaylist", () => {
  it("answers with an empty ok, and takes the row and the file with it", async () => {
    const response = await callPlaylists("deletePlaylist", [["id", mix.id]]);

    expect(response.status).toBe("ok");
    expect(response.playlist).toBeUndefined();
    expect(await fileOf(mix.id)).toBeNull();
    expect((await playlists("getPlaylist", { id: mix.id })).error?.code).toBe(70);
  });

  it("does not let the next import bring it back", async () => {
    const runs = await importUntilComplete({}, passTime(2));

    expect(runs.at(-1)?.completed).toBe(true);
    expect((await playlists("getPlaylist", { id: mix.id })).error?.code).toBe(70);
    expect((await playlists("getPlaylists")).playlists?.playlist ?? []).not.toContainEqual(
      expect.objectContaining({ id: mix.id }),
    );
  });

  it("refuses a playlist somebody else owns with error 50, and leaves it there", async () => {
    const mine = await callPlaylists("createPlaylist", [["name", "Admin only"]]);
    const id = mine.playlist?.id ?? "";

    expect((await callPlaylists("deletePlaylist", [["id", id]], LISTENER)).error?.code).toBe(50);
    expect((await playlists("getPlaylist", { id })).status).toBe("ok");
  });

  it("lets an admin delete a playlist somebody else made", async () => {
    const theirs = await callPlaylists("createPlaylist", [["name", "Listener's"]], LISTENER);
    const id = theirs.playlist?.id ?? "";

    expect(theirs.playlist?.owner).toBe(LISTENER.user);
    expect((await callPlaylists("deletePlaylist", [["id", id]])).status).toBe("ok");
    expect((await playlists("getPlaylist", { id })).error?.code).toBe(70);
  });
});

describe("what the write endpoints refuse", () => {
  it("answers a create with neither name nor playlistId with error 10", async () => {
    const response = await callPlaylists("createPlaylist", [["songId", SONG_IDS[0] ?? ""]]);

    expect(response.error?.code).toBe(10);
    expect(response.error?.message).toBe("missing parameter: 'name or playlistId'");
  });

  it("answers a songId that names no track with error 70, and writes nothing", async () => {
    const unknown = prefixedId("track", trackId("Nobody/No Album/nothing.mp3"));
    const before = await playlistObjects();

    const response = await callPlaylists("createPlaylist", [
      ["name", "Broken"],
      ["songId", SONG_IDS[0] ?? ""],
      ["songId", unknown],
    ]);

    expect(response.error?.code).toBe(70);
    expect(response.error?.message).toBe("Song not found");
    expect((await playlistObjects()).size).toBe(before.size);
  });

  it("answers a songId that is not one of ours with error 70", async () => {
    const response = await callPlaylists("createPlaylist", [
      ["name", "Broken"],
      ["songId", "not-an-id"],
    ]);

    expect(response.error?.code).toBe(70);
  });

  it("answers a playlistId that names nothing with error 70", async () => {
    const unknown = prefixedId("playlist", playlistId("playlists/nowhere.m3u"));

    expect((await callPlaylists("createPlaylist", [["playlistId", unknown]])).error?.code).toBe(70);
  });

  it("answers a delete with no id with error 10, and an unknown id with error 70", async () => {
    const unknown = prefixedId("playlist", playlistId("playlists/nowhere.m3u"));

    expect((await callPlaylists("deletePlaylist", [])).error?.code).toBe(10);
    expect((await callPlaylists("deletePlaylist", [["id", unknown]])).error?.code).toBe(70);
    expect((await callPlaylists("deletePlaylist", [["id", "not-an-id"]])).error?.code).toBe(70);
  });

  it("refuses more songIds than the cap, before writing anything to the bucket", async () => {
    const before = (await playlistObjects()).size;
    const tooMany: [string, string][] = Array.from({ length: 1001 }, (_, index) => [
      "songId",
      prefixedId("track", trackId(`Silent Artist/Quiet Album/never-${index}.mp3`)),
    ]);

    const response = await callPlaylists("createPlaylist", [["name", "Too Long"], ...tooMany]);

    expect(response.error?.code).toBe(0);
    expect(response.error?.message).toContain("too many ids");
    expect((await playlistObjects()).size).toBe(before);
  });
});

describe("the sweep and a playlist created while a pass was running", () => {
  const YOUNG = "playlists/created-mid-pass.m3u";
  const OLD = "playlists/long-gone.m3u";

  it("removes the row whose file went before the pass, and keeps the younger one", async () => {
    // Neither has a file: the young one stands for a playlist a client
    // created after this pass listed the page its key falls in, which the
    // pass cannot see and must not delete.
    await seedPlaylist({ r2Key: OLD, createdAt: new Date(Date.now() - 60 * 60_000) });
    await seedPlaylist({ r2Key: YOUNG, createdAt: passTime(10) });

    const runs = await importUntilComplete({}, passTime(3));

    expect(runs.at(-1)?.completed).toBe(true);
    const keys = (await storedPlaylists()).map((row) => row.r2Key);
    expect(keys).toContain(YOUNG);
    expect(keys).not.toContain(OLD);
  });

  it("removes the young row once a later pass has begun after it", async () => {
    const runs = await importUntilComplete({}, passTime(20));

    expect(runs.at(-1)?.completed).toBe(true);
    expect((await storedPlaylists()).map((row) => row.r2Key)).not.toContain(YOUNG);
  });
});
