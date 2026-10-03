import { album, playQueue, track, trackLyrics } from "@stratosonic/db";
import { eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signPublicImageToken } from "../src/auth/public-token";
import { database } from "../src/db";
import {
  ADMIN,
  afterAuthentication,
  countingApp,
  ids,
  LISTENER_BOTH,
  LISTENER_TWO,
  namesALibrary,
  PASSWORD,
  type ScopeUsers,
  SHARED_KEY,
  type SubsonicJson,
  seedTwoLibraries,
} from "./library-scope-support";
import {
  BASE,
  encryptionKey,
  SEED_TIME,
  seedAnnotation,
  seedPlaylist,
  seedUser,
  testEnv,
} from "./support";

/**
 * Library access on the id endpoints (#84, "Out of scope means not found",
 * ticket D2): an id in a library the caller cannot see is error 70 wherever
 * a client names one, and a write naming it writes nothing; the queue, the
 * bookmarks and a playlist's entries leave such tracks out; and what is
 * unscoped in Navidrome (the now-playing feed, the public image URL) stays
 * so.
 *
 * D1's fixtures: libraries 1 and 2, the admin, `two` (library 2 only) and
 * `both` (both, as a listener: the fast path). `one` is added here, a
 * listener of library 1 only, who is scoped without needing a library row:
 * every track they can see is the bound bucket's.
 *
 * Library 2 has no bucket here, so nothing reads a library-2 track's bytes;
 * library-scope-s3.test.ts streams them from the fake S3.
 */

const { d1, call, fetch } = countingApp();
const LISTENER_ONE = "one";
let users: ScopeUsers & { readonly oneId: string };

const JAZZ_KEY = "Only One/First Only/01 Jazz.flac";
const tr = (id: string) => `tr-${id}`;
const al = (id: string) => `al-${id}`;
const ar = (id: string) => `ar-${id}`;

/** Each cover's bytes: a JPEG signature, then which cover it is. */
const COVERS = {
  sharedAlbum1: `_covers/${ids.sharedAlbum1}.jpg`,
  sharedAlbum2: `_covers/${ids.sharedAlbum2}.jpg`,
  firstOnly: "_covers/first-only.jpg",
  secondOnly: "_covers/second-only.jpg",
} as const;

function coverBytes(name: string): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode(name)]);
}

beforeAll(async () => {
  const seeded = await seedTwoLibraries();
  const oneId = await seedUser(LISTENER_ONE, PASSWORD);
  users = { ...seeded, oneId };

  // The library-1 album only `one`, the admin and `both` see gets a cover,
  // so an artist and an album of library 1 alone each have one to refuse.
  await database(testEnv)
    .update(album)
    .set({ coverKey: COVERS.firstOnly })
    .where(eq(album.id, ids.firstOnly));
  for (const [name, key] of Object.entries(COVERS)) {
    await testEnv.MUSIC.put(key, coverBytes(name));
  }
  await testEnv.MUSIC.put(SHARED_KEY, new TextEncoder().encode("shared song, library 1"));
  await testEnv.MUSIC.put(JAZZ_KEY, new TextEncoder().encode("jazz, library 1"));
  // Library 1's jazz track carries a lyric in its tags, so a lookup that
  // found it would answer with it.
  await database(testEnv)
    .insert(trackLyrics)
    .values({ trackId: ids.jazzTrack, text: "[00:01.00]a jazz line", lang: "eng" });

  for (const user of [ADMIN, LISTENER_TWO, LISTENER_BOTH, LISTENER_ONE]) {
    await call(user, "ping");
  }
});

/** The error a refused request answered, as the envelope carries it. */
async function refusal(response: Response): Promise<{ code: number; message: string }> {
  expect(response.headers.get("Content-Type")).toMatch(/application\/json/);
  const body = (await response.json()) as { "subsonic-response": SubsonicJson };
  expect(body["subsonic-response"].status).toBe("failed");
  return body["subsonic-response"].error;
}

/** Every row a write could touch, so a test can say none moved. */
async function writableState(): Promise<string> {
  const tables = [
    "annotation",
    "bookmark",
    "play_queue",
    "now_playing",
    "playlist",
    "playlist_track",
  ];
  const rows = await Promise.all(
    tables.map(async (table) => {
      const { results } = await testEnv.DB.prepare(`select * from ${table} order by 1, 2`).all();
      return [table, results] as const;
    }),
  );
  const objects = await testEnv.MUSIC.list({ prefix: "playlists/" });

  return JSON.stringify({
    rows,
    objects: objects.objects.map((object) => [object.key, object.etag]),
  });
}

/* ------------------------------------------------------------- reads -- */

/** The id reads, each with a library-1 id and what a refusal says. */
const READS: readonly (readonly [string, readonly (readonly [string, string])[], string])[] = [
  ["getSong", [["id", tr(ids.jazzTrack)]], "Song not found"],
  ["getAlbum", [["id", al(ids.firstOnly)]], "Album not found"],
  ["getArtist", [["id", ar(ids.onlyOne)]], "Artist not found"],
  ["getMusicDirectory", [["id", ar(ids.onlyOne)]], "Directory not found"],
  ["getMusicDirectory", [["id", al(ids.firstOnly)]], "Directory not found"],
  ["getLyricsBySongId", [["id", tr(ids.jazzTrack)]], "data not found"],
];

describe("an id read out of the caller's libraries", () => {
  it.each(READS)("is not found by %s %j", async (endpoint, params, message) => {
    expect((await call(LISTENER_TWO, endpoint, params)).error).toEqual({ code: 70, message });
    for (const user of [ADMIN, LISTENER_BOTH, LISTENER_ONE]) {
      expect((await call(user, endpoint, params)).status, user).toBe("ok");
    }
  });

  it.each([
    ["getSong", tr(ids.calmTrack)],
    ["getAlbum", al(ids.secondOnly)],
    ["getArtist", ar(ids.onlyTwo)],
    ["getMusicDirectory", al(ids.secondOnly)],
    ["getLyricsBySongId", tr(ids.calmTrack)],
  ])("is not found by %s for a listener of library 1 alone", async (endpoint, id) => {
    expect((await call(LISTENER_ONE, endpoint, [["id", id]])).error?.code).toBe(70);
  });

  it.each(["stream", "download"])(
    "is not found by %s, before any bytes are read",
    async (endpoint) => {
      expect(
        await refusal(await fetch(LISTENER_TWO, endpoint, [["id", tr(ids.jazzTrack)]])),
      ).toEqual({ code: 70, message: "The requested data was not found" });
      expect(
        await refusal(await fetch(LISTENER_ONE, endpoint, [["id", tr(ids.calmTrack)]])),
      ).toEqual({ code: 70, message: "The requested data was not found" });

      for (const user of [ADMIN, LISTENER_BOTH, LISTENER_ONE]) {
        const response = await fetch(user, endpoint, [["id", tr(ids.jazzTrack)]]);
        expect(response.status, user).toBe(200);
        expect(await response.text(), user).toBe("jazz, library 1");
      }
    },
  );

  it("is not found by getCoverArt, for an album, a track and an artist", async () => {
    for (const id of [al(ids.sharedAlbum1), tr(ids.sharedTrack1), ar(ids.onlyOne)]) {
      expect(await refusal(await fetch(LISTENER_TWO, "getCoverArt", [["id", id]]))).toEqual({
        code: 70,
        message: "Artwork not found",
      });
      for (const user of [ADMIN, LISTENER_BOTH, LISTENER_ONE]) {
        expect((await fetch(user, "getCoverArt", [["id", id]])).status, `${user} ${id}`).toBe(200);
      }
    }
    expect(
      await refusal(await fetch(LISTENER_ONE, "getCoverArt", [["id", al(ids.secondOnly)]])),
    ).toMatchObject({ code: 70 });
  });

  it("gives getCoverArt an artist's cover from its albums in scope, as getArtist names it", async () => {
    const artist = (await call(LISTENER_TWO, "getArtist", [["id", ar(ids.sharedArtist)]])).artist;
    expect(artist.coverArt).toBe(al(ids.sharedAlbum2));

    const served = await fetch(LISTENER_TWO, "getCoverArt", [["id", ar(ids.sharedArtist)]]);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(coverBytes("sharedAlbum2"));

    const forOne = await fetch(LISTENER_ONE, "getCoverArt", [["id", ar(ids.sharedArtist)]]);
    expect(new Uint8Array(await forOne.arrayBuffer())).toEqual(coverBytes("sharedAlbum1"));
  });

  it("finds no getLyrics candidate out of the caller's libraries", async () => {
    const asked: [string, string][] = [
      ["artist", "Only One"],
      ["title", "01 Jazz"],
    ];

    expect((await call(LISTENER_TWO, "getLyrics", asked)).lyrics).toEqual({ value: "" });
    for (const user of [ADMIN, LISTENER_BOTH, LISTENER_ONE]) {
      expect((await call(user, "getLyrics", asked)).lyrics?.value, user).toBe("a jazz line\n");
    }
    expect(
      (
        await call(LISTENER_ONE, "getLyrics", [
          ["artist", "Only Two"],
          ["title", "01 Calm"],
        ])
      ).lyrics,
    ).toEqual({ value: "" });
  });

  it("reads getLyricsBySongId's lyric for the users who see the track", async () => {
    for (const user of [ADMIN, LISTENER_BOTH, LISTENER_ONE]) {
      const body = await call(user, "getLyricsBySongId", [["id", tr(ids.jazzTrack)]]);
      expect(body.lyricsList.structuredLyrics[0].line[0].value, user).toBe("a jazz line");
    }
  });
});

describe("what stays unscoped, as in Navidrome", () => {
  it("getNowPlaying shows every session, whatever library its track is in", async () => {
    expect(
      (
        await call(LISTENER_BOTH, "reportPlayback", [
          ["mediaId", tr(ids.jazzTrack)],
          ["mediaType", "song"],
          ["positionMs", "1000"],
          ["state", "playing"],
        ])
      ).status,
    ).toBe("ok");

    const feed = (await call(LISTENER_TWO, "getNowPlaying")).nowPlaying.entry;
    expect(feed.map((entry: SubsonicJson) => [entry.id, entry.username])).toContainEqual([
      tr(ids.jazzTrack),
      LISTENER_BOTH,
    ]);
  });

  it("the public image URL serves any library's cover", async () => {
    const app = createApp();
    for (const [id, name] of [
      [al(ids.sharedAlbum1), "sharedAlbum1"],
      [al(ids.secondOnly), "secondOnly"],
      [ar(ids.onlyOne), "firstOnly"],
    ] as const) {
      const token = await signPublicImageToken(encryptionKey(), id);
      const response = await app.request(`${BASE}/share/img/${token}`, undefined, testEnv);
      expect(response.status, id).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(coverBytes(name));
    }
  });
});

/* ------------------------------------------------------------ writes -- */

describe("a write naming an id out of the caller's libraries", () => {
  beforeAll(async () => {
    // `two` starts with no annotation but one starred track of library 1,
    // so a star that went through would add a row, and an unstar change one.
    await testEnv.DB.prepare("delete from annotation where user_id = ?").bind(users.twoId).run();
    await seedAnnotation({ userId: users.twoId, itemId: ids.sharedTrack1, itemType: "track" });
  });

  /** Each refused write: endpoint and parameters. */
  const REFUSED: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
    ["star", [["id", tr(ids.jazzTrack)]]],
    ["star", [["albumId", al(ids.firstOnly)]]],
    ["star", [["artistId", ar(ids.onlyOne)]]],
    [
      "star",
      [
        ["id", tr(ids.calmTrack)],
        ["id", tr(ids.sharedTrack1)],
      ],
    ],
    ["unstar", [["id", tr(ids.sharedTrack1)]]],
    [
      "setRating",
      [
        ["id", tr(ids.jazzTrack)],
        ["rating", "3"],
      ],
    ],
    [
      "setRating",
      [
        ["id", al(ids.sharedAlbum1)],
        ["rating", "3"],
      ],
    ],
    [
      "setRating",
      [
        ["id", ar(ids.onlyOne)],
        ["rating", "3"],
      ],
    ],
    ["scrobble", [["id", tr(ids.jazzTrack)]]],
    [
      "scrobble",
      [
        ["id", tr(ids.calmTrack)],
        ["id", tr(ids.jazzTrack)],
      ],
    ],
    [
      "scrobble",
      [
        ["id", tr(ids.jazzTrack)],
        ["submission", "false"],
      ],
    ],
    [
      "scrobble",
      [
        ["id", tr(ids.calmTrack)],
        ["id", tr(ids.jazzTrack)],
        ["submission", "false"],
      ],
    ],
    [
      "reportPlayback",
      [
        ["mediaId", tr(ids.jazzTrack)],
        ["mediaType", "song"],
        ["positionMs", "0"],
        ["state", "starting"],
      ],
    ],
    [
      "createBookmark",
      [
        ["id", tr(ids.jazzTrack)],
        ["position", "1000"],
      ],
    ],
    [
      "savePlayQueue",
      [
        ["id", tr(ids.calmTrack)],
        ["id", tr(ids.jazzTrack)],
      ],
    ],
    [
      "savePlayQueue",
      [
        ["id", tr(ids.calmTrack)],
        ["current", tr(ids.jazzTrack)],
      ],
    ],
  ];

  it.each(REFUSED)("is error 70 from %s %j, and writes nothing", async (endpoint, params) => {
    const before = await writableState();

    expect((await call(LISTENER_TWO, endpoint, params)).error, endpoint).toEqual({
      code: 70,
      message: "The requested data was not found",
    });
    expect(await writableState()).toBe(before);
  });

  it("is refused to a listener of library 1 alone for a library-2 id", async () => {
    for (const [endpoint, params] of [
      ["star", [["id", tr(ids.calmTrack)]]],
      ["star", [["albumId", al(ids.secondOnly)]]],
      ["star", [["artistId", ar(ids.onlyTwo)]]],
      ["scrobble", [["id", tr(ids.calmTrack)]]],
      [
        "reportPlayback",
        [
          ["mediaId", tr(ids.calmTrack)],
          ["mediaType", "song"],
          ["positionMs", "0"],
          ["state", "playing"],
        ],
      ],
      [
        "createBookmark",
        [
          ["id", tr(ids.calmTrack)],
          ["position", "1"],
        ],
      ],
      ["savePlayQueue", [["id", tr(ids.calmTrack)]]],
    ] as const) {
      const before = await writableState();
      expect((await call(LISTENER_ONE, endpoint, params)).error?.code, endpoint).toBe(70);
      expect(await writableState()).toBe(before);
    }
  });

  it("goes through for the ids in scope, and for the users who see them", async () => {
    // The shared artist is in library 2 too, through its album there.
    for (const params of [
      [["id", tr(ids.calmTrack)]],
      [["albumId", al(ids.sharedAlbum2)]],
      [["artistId", ar(ids.sharedArtist)]],
    ] as const) {
      expect((await call(LISTENER_TWO, "star", params)).status).toBe("ok");
    }
    expect(
      (
        await call(LISTENER_TWO, "savePlayQueue", [
          ["id", tr(ids.calmTrack)],
          ["id", tr(ids.sharedTrack2)],
          ["current", tr(ids.sharedTrack2)],
        ])
      ).status,
    ).toBe("ok");

    for (const user of [ADMIN, LISTENER_BOTH]) {
      for (const [endpoint, params] of REFUSED) {
        expect((await call(user, endpoint, params)).status, `${user} ${endpoint}`).toBe("ok");
      }
    }
  });
});

/* -------------------------------------------- queue, bookmarks, lists -- */

describe("the reads of what a user saved", () => {
  const EVERY_TRACK = [ids.jazzTrack, ids.calmTrack, ids.sharedTrack1, ids.sharedTrack2];

  beforeAll(async () => {
    const db = database(testEnv);
    for (const userId of [users.twoId, users.bothId]) {
      await db
        .insert(playQueue)
        .values({ userId, trackIds: JSON.stringify(EVERY_TRACK), changedAt: SEED_TIME })
        .onConflictDoUpdate({
          target: playQueue.userId,
          set: { trackIds: JSON.stringify(EVERY_TRACK) },
        });
      await testEnv.DB.prepare("delete from bookmark where user_id = ?").bind(userId).run();
      for (const trackId of EVERY_TRACK) {
        await testEnv.DB.prepare(
          "insert into bookmark (user_id, track_id, position, comment, created_at, changed_at) values (?, ?, 1, '', 0, 0)",
        )
          .bind(userId, trackId)
          .run();
      }
    }
  });

  /** A queue's or the bookmarks' track ids, in the order answered. */
  const trackIdsOf = (entries: SubsonicJson[] | undefined) =>
    (entries ?? []).map((entry) => entry.id ?? entry.entry?.id);

  it("getPlayQueue leaves out the tracks out of scope, in order", async () => {
    expect(trackIdsOf((await call(LISTENER_TWO, "getPlayQueue")).playQueue.entry)).toEqual([
      tr(ids.calmTrack),
      tr(ids.sharedTrack2),
    ]);
    expect(trackIdsOf((await call(LISTENER_BOTH, "getPlayQueue")).playQueue.entry)).toEqual(
      EVERY_TRACK.map(tr),
    );
  });

  it("getBookmarks leaves them out, and keeps them stored", async () => {
    const forTwo = trackIdsOf((await call(LISTENER_TWO, "getBookmarks")).bookmarks.bookmark);
    expect(forTwo.sort()).toEqual([tr(ids.calmTrack), tr(ids.sharedTrack2)].sort());
    const forBoth = trackIdsOf((await call(LISTENER_BOTH, "getBookmarks")).bookmarks.bookmark);
    expect(forBoth.sort()).toEqual(EVERY_TRACK.map(tr).sort());

    const { results } = await testEnv.DB.prepare(
      "select count(*) as n from bookmark where user_id = ?",
    )
      .bind(users.twoId)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(4);
  });
});

/* ---------------------------------------------------------- playlists -- */

describe("a playlist across both libraries, for a listener of one", () => {
  const KEY = "playlists/across.m3u";
  /** Stored order: library 1, 2, 1, 2. `two` sees positions 1 and 3. */
  const STORED = [ids.jazzTrack, ids.calmTrack, ids.sharedTrack1, ids.sharedTrack2];
  let playlistId = "";

  beforeAll(async () => {
    const rows = await database(testEnv).select().from(track).where(inArray(track.id, STORED));
    const ordered = STORED.map((id) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row === undefined) throw new Error(`no track ${id}`);
      return row;
    });
    const seeded = await seedPlaylist({
      r2Key: KEY,
      name: "Across",
      ownerId: users.twoId,
      tracks: ordered,
    });
    playlistId = `pl-${seeded.id}`;
    await testEnv.MUSIC.put(KEY, `#EXTM3U\n#PLAYLIST:Across\n${JAZZ_KEY}\n`);
  });

  async function storedEntries(): Promise<string[]> {
    const { results } = await testEnv.DB.prepare(
      "select track_id from playlist_track where playlist_id = ? order by position",
    )
      .bind(playlistId.slice(3))
      .all<{ track_id: string }>();
    return results.map((row) => row.track_id);
  }

  it("getPlaylist lists the entries in scope, with the stored totals", async () => {
    const forTwo = (await call(LISTENER_TWO, "getPlaylist", [["id", playlistId]])).playlist;
    const forAdmin = (await call(ADMIN, "getPlaylist", [["id", playlistId]])).playlist;

    expect(forTwo.entry.map((entry: SubsonicJson) => entry.id)).toEqual([
      tr(ids.calmTrack),
      tr(ids.sharedTrack2),
    ]);
    expect(forAdmin.entry.map((entry: SubsonicJson) => entry.id)).toEqual(STORED.map(tr));
    expect(forTwo.songCount).toBe(4);
    expect(forTwo.duration).toBe(forAdmin.duration);
  });

  it("lends each user a cover from the entries they see", async () => {
    const coverOf = async (user: string) =>
      (await call(user, "getPlaylists")).playlists.playlist.find(
        (entry: SubsonicJson) => entry.id === playlistId,
      )?.coverArt;

    expect(await coverOf(ADMIN)).toBe(al(ids.firstOnly));
    expect(await coverOf(LISTENER_TWO)).toBe(al(ids.secondOnly));
    expect((await call(LISTENER_TWO, "getPlaylist", [["id", playlistId]])).playlist.coverArt).toBe(
      al(ids.secondOnly),
    );
  });

  it("refuses a song id out of scope as Song not found, writing nothing", async () => {
    const before = await writableState();

    expect(
      (
        await call(LISTENER_TWO, "updatePlaylist", [
          ["playlistId", playlistId],
          ["songIdToAdd", tr(ids.calmTrack)],
          ["songIdToAdd", tr(ids.jazzTrack)],
        ])
      ).error,
    ).toEqual({ code: 70, message: "Song not found" });
    expect(
      (
        await call(LISTENER_TWO, "createPlaylist", [
          ["name", "Mine"],
          ["songId", tr(ids.calmTrack)],
          ["songId", tr(ids.sharedTrack1)],
        ])
      ).error,
    ).toEqual({ code: 70, message: "Song not found" });
    expect(
      (
        await call(LISTENER_ONE, "createPlaylist", [
          ["name", "Mine"],
          ["songId", tr(ids.calmTrack)],
        ])
      ).error,
    ).toEqual({ code: 70, message: "Song not found" });

    expect(await writableState()).toBe(before);
  });

  it("keeps the hidden entries through an edit, and removes the visible position asked", async () => {
    // Visible position 1 is the shared song of library 2, stored at 3; there
    // is no visible position 5.
    expect(
      (
        await call(LISTENER_TWO, "updatePlaylist", [
          ["playlistId", playlistId],
          ["songIndexToRemove", "1"],
          ["songIndexToRemove", "5"],
          ["songIdToAdd", tr(ids.calmTrack)],
          ["comment", "edited"],
        ])
      ).status,
    ).toBe("ok");

    expect(await storedEntries()).toEqual([
      ids.jazzTrack,
      ids.calmTrack,
      ids.sharedTrack1,
      ids.calmTrack,
    ]);
    const file = await (await testEnv.MUSIC.get(KEY))?.text();
    expect(file).toContain(JAZZ_KEY);
    expect(file).toContain(SHARED_KEY);

    // Now `two` sees the calm song twice, at stored positions 1 and 3.
    expect(
      (
        await call(LISTENER_TWO, "updatePlaylist", [
          ["playlistId", playlistId],
          ["songIndexToRemove", "1"],
        ])
      ).status,
    ).toBe("ok");
    expect(await storedEntries()).toEqual([ids.jazzTrack, ids.calmTrack, ids.sharedTrack1]);
    expect((await call(LISTENER_TWO, "getPlaylist", [["id", playlistId]])).playlist.songCount).toBe(
      3,
    );
  });

  it("removes stored positions as asked for a user who sees every library", async () => {
    expect(
      (
        await call(ADMIN, "updatePlaylist", [
          ["playlistId", playlistId],
          ["songIndexToRemove", "1"],
        ])
      ).status,
    ).toBe("ok");
    expect(await storedEntries()).toEqual([ids.jazzTrack, ids.sharedTrack1]);
  });
});

/* ---------------------------------------------------------- fast path -- */

describe("the fast path on the id endpoints, with two libraries", () => {
  /** Each endpoint, its parameters, and what v0.5.0 ran besides authenticating. */
  const V050: readonly (readonly [string, readonly (readonly [string, string])[], number])[] = [
    ["getSong", [["id", tr(ids.jazzTrack)]], 1],
    ["getLyricsBySongId", [["id", tr(ids.jazzTrack)]], 1],
    [
      "getLyrics",
      [
        ["artist", "Only One"],
        ["title", "01 Jazz"],
      ],
      1,
    ],
    // Saved first, so the queue read next has entries to resolve.
    ["savePlayQueue", [["id", tr(ids.jazzTrack)]], 1],
    ["getPlayQueue", [], 2],
    ["getBookmarks", [], 1],
    ["star", [["id", tr(ids.jazzTrack)]], 2],
    [
      "setRating",
      [
        ["id", tr(ids.jazzTrack)],
        ["rating", "4"],
      ],
      2,
    ],
    ["scrobble", [["id", tr(ids.jazzTrack)]], 4],
    [
      "createBookmark",
      [
        ["id", tr(ids.jazzTrack)],
        ["position", "5"],
      ],
      2,
    ],
  ];

  it.each([ADMIN, LISTENER_BOTH])(
    "%s runs v0.5.0's statements, with no predicate",
    async (user) => {
      for (const [endpoint, params, expected] of V050) {
        d1.reset();
        const body = await call(user, endpoint, params);
        expect(body.status, endpoint).toBe("ok");

        const statements = afterAuthentication(d1.statements);
        expect(statements, endpoint).toHaveLength(expected);
        expect(namesALibrary(statements), endpoint).toBe(false);
      }
      for (const [endpoint, id] of [
        ["stream", tr(ids.jazzTrack)],
        ["download", tr(ids.jazzTrack)],
        ["getCoverArt", al(ids.firstOnly)],
        ["getCoverArt", ar(ids.onlyOne)],
      ] as const) {
        d1.reset();
        expect((await fetch(user, endpoint, [["id", id]])).status, endpoint).toBe(200);
        const statements = afterAuthentication(d1.statements);
        expect(statements, endpoint).toHaveLength(id.startsWith("ar-") ? 2 : 1);
        expect(namesALibrary(statements), endpoint).toBe(false);
      }
    },
  );

  it("joins the track's library onto stream's one lookup, for a caller who sees more than library 1", async () => {
    for (const [user, joins] of [
      [ADMIN, true],
      [LISTENER_BOTH, true],
      [LISTENER_ONE, false],
    ] as const) {
      d1.reset();
      expect((await fetch(user, "stream", [["id", tr(ids.jazzTrack)]])).status).toBe(200);
      const [lookup, ...rest] = afterAuthentication(d1.statements);
      expect(rest).toEqual([]);
      expect(/\bjoin "library"/.test(lookup?.sql ?? ""), user).toBe(joins);
    }
  });

  it("adds no statement for a scoped user but savePlayQueue's check", async () => {
    for (const [endpoint, params, expected] of V050) {
      d1.reset();
      await call(LISTENER_TWO, endpoint, params);
      const statements = afterAuthentication(d1.statements);
      expect(statements.length, endpoint).toBeLessThanOrEqual(
        endpoint === "savePlayQueue" ? expected + 1 : expected,
      );
    }
  });
});
