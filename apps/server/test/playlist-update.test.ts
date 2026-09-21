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
  storedPlaylists,
} from "./playlists-support";
import { seedAlbum, seedArtist, seedTrack, seedUser } from "./support";

/**
 * `updatePlaylist`, as a client uses it: a playlist is made, then renamed,
 * added to, cut down and made private, and after every edit the bucket and
 * the rows still agree - which is what the next import will check for us.
 *
 * Everything is asserted over HTTP except the `.m3u` itself, which is read
 * from the bucket directly because no endpoint serves one.
 */

const ARTIST = "Quiet Artist";
const ALBUM = "Long Album";
const TITLES = ["One", "Two", "Three", "Four", "Five"];

const KEYS = TITLES.map((title, index) => {
  return `${ARTIST}/${ALBUM}/${String(index + 1).padStart(2, "0")} ${title}.mp3`;
});

const SONG_IDS = KEYS.map((key) => prefixedId("track", trackId(key)));

/** Each track lasts a distinct number of seconds, so a total names its set. */
const DURATIONS = [10, 20, 40, 80, 160];

const LISTENER: PlaylistCaller = { user: "listener", password: "hunter2" };

beforeAll(async () => {
  await bootstrapAdmin();
  await seedUser(LISTENER.user, LISTENER.password);

  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: 2022, songCount: KEYS.length });

  for (const [index, r2Key] of KEYS.entries()) {
    await seedTrack({
      r2Key,
      title: TITLES[index],
      album: ALBUM,
      albumArtist: ARTIST,
      year: 2022,
      duration: DURATIONS[index],
    });
  }
});

/** Creates a playlist of these songs and answers with it. */
async function create(
  name: string,
  songs: readonly string[] = [],
): Promise<SubsonicPlaylistElement> {
  const response = await callPlaylists("createPlaylist", [
    ["name", name],
    ...songs.map((id) => ["songId", id] as const),
  ]);

  const created = response.playlist;
  if (created === undefined) {
    throw new Error(`createPlaylist failed: ${JSON.stringify(response)}`);
  }

  return created;
}

/** The playlist as `getPlaylist` answers with it now. */
async function read(id: string): Promise<SubsonicPlaylistElement> {
  const found = (await playlists("getPlaylist", { id })).playlist;
  if (found === undefined) {
    throw new Error(`getPlaylist ${id} failed`);
  }

  return found;
}

/** The titles of a playlist's entries, in order. */
function titles(playlist: SubsonicPlaylistElement): string[] {
  return (playlist.entry ?? []).map((entry) => entry.title);
}

/** The `.m3u` of the playlist with this client id, and the key it lives at. */
async function fileOf(id: string): Promise<{ key: string; text: string }> {
  for (const [key, text] of await playlistObjects()) {
    if (prefixedId("playlist", playlistId(key)) === id) {
      return { key, text };
    }
  }

  throw new Error(`no object for ${id}`);
}

function update(
  parameters: readonly (readonly [string, string])[],
  caller: PlaylistCaller = { user: "admin", password: "sesame" },
) {
  return callPlaylists("updatePlaylist", parameters, caller);
}

describe("adding songs", () => {
  it("appends the song and moves songCount and duration", async () => {
    const mix = await create("Adding", [SONG_IDS[0] ?? "", SONG_IDS[1] ?? ""]);

    const response = await update([
      ["playlistId", mix.id],
      ["songIdToAdd", SONG_IDS[2] ?? ""],
    ]);
    expect(response.status).toBe("ok");
    expect(response.playlist).toBeUndefined();

    const after = await read(mix.id);
    expect(titles(after)).toEqual(["One", "Two", "Three"]);
    expect(after.songCount).toBe(3);
    expect(after.duration).toBe(10 + 20 + 40);
  });

  it("appends several in the order they were sent, duplicates and all", async () => {
    const mix = await create("Adding several", [SONG_IDS[0] ?? ""]);

    await update([
      ["playlistId", mix.id],
      ["songIdToAdd", SONG_IDS[2] ?? ""],
      ["songIdToAdd", SONG_IDS[0] ?? ""],
    ]);

    expect(titles(await read(mix.id))).toEqual(["One", "Three", "One"]);
  });
});

describe("removing songs", () => {
  it("removes exactly the positions the playlist had before the call", async () => {
    const mix = await create("Removing", SONG_IDS.slice(0, 4));

    await update([
      ["playlistId", mix.id],
      ["songIndexToRemove", "0"],
      ["songIndexToRemove", "2"],
    ]);

    expect(titles(await read(mix.id))).toEqual(["Two", "Four"]);
  });

  it("reads the indexes against the old list even when songs are added too", async () => {
    const mix = await create("Both at once", SONG_IDS.slice(0, 3));

    await update([
      ["playlistId", mix.id],
      ["songIndexToRemove", "0"],
      ["songIndexToRemove", "2"],
      ["songIdToAdd", SONG_IDS[4] ?? ""],
    ]);

    // Positions 0 and 2 of One/Two/Three go, then Five is appended - not
    // position 2 of the list that the addition would have made.
    expect(titles(await read(mix.id))).toEqual(["Two", "Five"]);
  });

  it("ignores an index that names no position, as Navidrome does", async () => {
    const mix = await create("Out of range", SONG_IDS.slice(0, 2));

    const response = await update([
      ["playlistId", mix.id],
      ["songIndexToRemove", "7"],
    ]);

    expect(response.status).toBe("ok");
    expect(titles(await read(mix.id))).toEqual(["One", "Two"]);
  });

  it("can empty a playlist without deleting it", async () => {
    const mix = await create("Emptied", SONG_IDS.slice(0, 2));

    await update([
      ["playlistId", mix.id],
      ["songIndexToRemove", "0"],
      ["songIndexToRemove", "1"],
    ]);

    const after = await read(mix.id);
    expect(after.entry).toBeUndefined();
    expect(after.songCount).toBe(0);
    expect(after.duration).toBe(0);
  });
});

describe("renaming", () => {
  it("renames the playlist and the file, keeping the id and the key", async () => {
    const mix = await create("Old Name", [SONG_IDS[0] ?? ""]);
    const before = await fileOf(mix.id);

    await update([
      ["playlistId", mix.id],
      ["name", "New"],
    ]);

    const after = await read(mix.id);
    expect(after.name).toBe("New");
    expect(after.id).toBe(mix.id);

    const file = await fileOf(mix.id);
    expect(file.key).toBe(before.key);
    expect(file.text).toContain("#PLAYLIST:New");
    expect(file.text).not.toContain("Old Name");
  });

  it("keeps the name when the client sends none", async () => {
    const mix = await create("Unchanged", [SONG_IDS[0] ?? ""]);

    await update([
      ["playlistId", mix.id],
      ["comment", "just a comment"],
    ]);

    expect((await read(mix.id)).name).toBe("Unchanged");
  });
});

describe("comment and public", () => {
  it("stores both, and leaves each alone when it is not sent", async () => {
    const mix = await create("Flags", [SONG_IDS[0] ?? ""]);

    await update([
      ["playlistId", mix.id],
      ["comment", "for the drive"],
      ["public", "false"],
    ]);

    const after = await read(mix.id);
    expect(after.comment).toBe("for the drive");
    expect(after.public).toBe(false);

    // A later update that mentions neither leaves both as they were.
    await update([
      ["playlistId", mix.id],
      ["songIdToAdd", SONG_IDS[1] ?? ""],
    ]);

    const later = await read(mix.id);
    expect(later.comment).toBe("for the drive");
    expect(later.public).toBe(false);
  });

  it("survives a re-import, which reads neither from the file", async () => {
    const mix = await create("Surviving", [SONG_IDS[0] ?? ""]);
    await update([
      ["playlistId", mix.id],
      ["comment", "kept"],
      ["public", "false"],
    ]);

    await importUntilComplete();

    const after = await read(mix.id);
    expect(after.comment).toBe("kept");
    expect(after.public).toBe(false);
  });
});

describe("timestamps", () => {
  it("moves changed and leaves created alone", async () => {
    const mix = await create("Timestamps", [SONG_IDS[0] ?? ""]);

    await update([
      ["playlistId", mix.id],
      ["songIdToAdd", SONG_IDS[1] ?? ""],
    ]);

    const after = await read(mix.id);
    expect(after.created).toBe(mix.created);
    expect(Date.parse(after.changed)).toBeGreaterThanOrEqual(Date.parse(mix.changed));
  });
});

describe("the bucket and the next import", () => {
  it("leaves an updated playlist that the importer then changes nothing about", async () => {
    const mix = await create("Converging", SONG_IDS.slice(0, 3));
    await update([
      ["playlistId", mix.id],
      ["songIndexToRemove", "1"],
      ["songIdToAdd", SONG_IDS[3] ?? ""],
      ["name", "Converged"],
    ]);

    const written = await read(mix.id);
    const file = await fileOf(mix.id);
    expect(file.text).toContain("#PLAYLIST:Converged");
    expect(file.text).toContain(KEYS[0] ?? "");
    expect(file.text).not.toContain(KEYS[1] ?? "");
    expect(file.text).toContain(KEYS[2] ?? "");
    expect(file.text).toContain(KEYS[3] ?? "");

    const rowsBefore = await storedPlaylists();
    await importUntilComplete();

    expect(await read(mix.id)).toEqual(written);
    expect(await storedPlaylists()).toEqual(rowsBefore);
  });
});

describe("who may update", () => {
  it("refuses someone else's playlist with error 50", async () => {
    const mix = await create("Not yours", [SONG_IDS[0] ?? ""]);

    const refused = await update(
      [
        ["playlistId", mix.id],
        ["name", "Mine now"],
      ],
      LISTENER,
    );

    expect(refused.error?.code).toBe(50);
    expect((await read(mix.id)).name).toBe("Not yours");
  });
});

describe("bad requests", () => {
  it("answers a missing playlistId with error 10", async () => {
    expect((await update([["name", "Nowhere"]])).error?.code).toBe(10);
  });

  it("answers a playlistId that names nothing with error 70", async () => {
    const unknown = prefixedId("playlist", playlistId("playlists/nowhere.m3u"));

    expect((await update([["playlistId", unknown]])).error?.code).toBe(70);
    expect((await update([["playlistId", "not-an-id"]])).error?.code).toBe(70);
  });

  it("answers a songIdToAdd that names no track with error 70", async () => {
    const mix = await create("Ghost song", [SONG_IDS[0] ?? ""]);
    const ghost = prefixedId("track", trackId(`${ARTIST}/${ALBUM}/99 Ghost.mp3`));

    const response = await update([
      ["playlistId", mix.id],
      ["songIdToAdd", ghost],
    ]);

    expect(response.error?.code).toBe(70);
    expect(titles(await read(mix.id))).toEqual(["One"]);
  });

  it("answers an index that is not a number with error 0", async () => {
    const mix = await create("Bad index", [SONG_IDS[0] ?? ""]);

    const response = await update([
      ["playlistId", mix.id],
      ["songIndexToRemove", "first"],
    ]);

    expect(response.error?.code).toBe(0);
    expect(titles(await read(mix.id))).toEqual(["One"]);
  });
});
