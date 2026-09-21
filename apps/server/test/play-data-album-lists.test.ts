import { albumId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { write } from "./annotations-support";
import { bootstrapAdmin } from "./browsing-support";
import { adminUserId, albumNames, list, listAs } from "./lists-support";
import { seedAlbum, seedAnnotation, seedArtist, seedTrack, seedUser } from "./support";

/**
 * `recent`, `frequent` and `highest` album lists: the three `getAlbumList2`
 * types Phase 1 left empty now fill in from the caller's own play and rating
 * data. Everything is set up over HTTP (scrobble, setRating) and read back
 * over HTTP (getAlbumList2), so the test asserts the behaviour a client sees.
 */

const ARTIST = "Nova";
const YEAR = 2001;

interface AlbumFixture {
  readonly name: string;
  readonly track: string;
}

const XANDU: AlbumFixture = { name: "Xandu", track: `${ARTIST}/Xandu/01 X.mp3` };
const YONDER: AlbumFixture = { name: "Yonder", track: `${ARTIST}/Yonder/01 Y.mp3` };
const ZEPHYR: AlbumFixture = { name: "Zephyr", track: `${ARTIST}/Zephyr/01 Z.mp3` };

const albumIdOf = (album: AlbumFixture) => prefixedId("album", albumId(ARTIST, album.name, YEAR));
const trackIdOf = (album: AlbumFixture) => prefixedId("track", trackId(album.track));

/** Someone else's account, which plays and rates an album the admin never does. */
const LISTENER = { user: "listener", password: "open-sesame" };

/** A third account that never annotates anything: its lists must stay empty. */
const NEWCOMER = { user: "newcomer", password: "let-me-in" };

beforeAll(async () => {
  await bootstrapAdmin();
  await adminUserId();
  const other = await seedUser(LISTENER.user, LISTENER.password);
  await seedUser(NEWCOMER.user, NEWCOMER.password);

  await seedArtist({ name: ARTIST });
  for (const album of [XANDU, YONDER, ZEPHYR]) {
    await seedAlbum({ name: album.name, albumArtist: ARTIST, year: YEAR, songCount: 1 });
    await seedTrack({ r2Key: album.track, album: album.name, albumArtist: ARTIST, year: YEAR });
  }

  // Xandu played twice, then Yonder once later — so Yonder is the most recent
  // and Xandu the most frequent. Zephyr is never played.
  await write("scrobble", { id: trackIdOf(XANDU), time: "1600000001000" });
  await write("scrobble", { id: trackIdOf(XANDU), time: "1600000002000" });
  await write("scrobble", { id: trackIdOf(YONDER), time: "1600000003000" });

  // Yonder rated above Xandu; Zephyr unrated.
  await write("setRating", { id: albumIdOf(XANDU), rating: "3" });
  await write("setRating", { id: albumIdOf(YONDER), rating: "5" });

  // The other account plays and rates Zephyr, which the admin never touches,
  // so every list below can be read as "the caller's own data" — no `it` has
  // to run before another for that to hold.
  await seedAnnotation({
    userId: other,
    itemId: albumId(ARTIST, ZEPHYR.name, YEAR),
    itemType: "album",
    starred: false,
    rating: 5,
    playCount: 9,
    playDate: new Date(1_600_000_009_000),
  });
});

describe("frequent", () => {
  it("orders by the caller's play count, most played first", async () => {
    expect(albumNames(await list("getAlbumList2", { type: "frequent" }))).toEqual([
      "Xandu",
      "Yonder",
    ]);
  });

  it("excludes an album the caller has never played", async () => {
    expect(albumNames(await list("getAlbumList2", { type: "frequent" }))).not.toContain("Zephyr");
  });
});

describe("recent", () => {
  it("orders by the caller's last play, most recent first", async () => {
    expect(albumNames(await list("getAlbumList2", { type: "recent" }))).toEqual([
      "Yonder",
      "Xandu",
    ]);
  });
});

describe("highest", () => {
  it("orders by the caller's rating, highest first, and drops the unrated", async () => {
    const names = albumNames(await list("getAlbumList2", { type: "highest" }));

    expect(names).toEqual(["Yonder", "Xandu"]);
    expect(names).not.toContain("Zephyr");
  });
});

describe("paging", () => {
  it("pages frequent stably with size and offset", async () => {
    const first = albumNames(
      await list("getAlbumList2", { type: "frequent", size: "1", offset: "0" }),
    );
    const second = albumNames(
      await list("getAlbumList2", { type: "frequent", size: "1", offset: "1" }),
    );

    expect(first).toEqual(["Xandu"]);
    expect(second).toEqual(["Yonder"]);
  });
});

describe("per-account", () => {
  it("does not let another account's data affect the caller's lists", async () => {
    expect(albumNames(await list("getAlbumList2", { type: "frequent" }))).not.toContain("Zephyr");
    expect(albumNames(await list("getAlbumList2", { type: "highest" }))).not.toContain("Zephyr");
  });

  it("shows the other account its own data, and none of the admin's", async () => {
    const frequent = albumNames(await listAs(LISTENER, "getAlbumList2", { type: "frequent" }));

    expect(frequent).toEqual(["Zephyr"]);
  });

  it.each(["recent", "frequent", "highest"])(
    "gives an account that has annotated nothing an empty %s list",
    async (type) => {
      const body = await listAs(NEWCOMER, "getAlbumList2", { type });

      expect(body.status).toBe("ok");
      expect(body.albumList2).toEqual({});
    },
  );
});
