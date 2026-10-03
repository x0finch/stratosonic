import {
  albumId,
  artistId,
  DEFAULT_LIBRARY_ID,
  ENTITY_ID_PREFIXES,
  md5,
  newHashId,
  normalizeIdPart,
  parseIdOfType,
  parsePrefixedId,
  playlistId,
  prefixedId,
  trackId,
} from "@stratosonic/db";
import { describe, expect, it } from "vitest";

const utf8 = new TextEncoder();

/**
 * Content-derived entity ids (ADR-0002).
 *
 * The digest and the hash ids are checked two ways: against values published
 * elsewhere - RFC 1321's own MD5 vectors, and the golden ids in Navidrome's
 * `model/id/id_test.go` - and against an implementation we did not write, by
 * recomputing them with the runtime's own MD5 and an encoder of this test's own.
 *
 * workerd implements MD5 in WebCrypto, which is why `ids.ts` cannot: Node's
 * WebCrypto does not, so the digest the ids are defined in terms of has to be
 * ours. Here, where only workerd runs, it makes a good independent witness.
 */

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Base62, written out here so the comparison does not lean on `encodeId`. */
function base62(bytes: Uint8Array): string {
  const digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let value = BigInt(`0x${hex(bytes)}`);
  let text = "";

  while (value > 0n) {
    text = digits[Number(value % 62n)] + text;
    value /= 62n;
  }

  return text.padStart(22, "0");
}

/** The runtime's own MD5, which is not the one `md5()` implements. */
async function runtimeMd5(message: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("MD5", message));
}

/** Navidrome's `id.NewHash`, recomputed with the runtime's MD5. */
async function independentHashId(...parts: string[]): Promise<string> {
  const joined = parts.map((part) => `${part}\u200b`).join("");

  return base62(await runtimeMd5(utf8.encode(joined)));
}

describe("md5", () => {
  it.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
    [
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
  ])("digests %j the way RFC 1321 says", (input, expected) => {
    expect(hex(md5(utf8.encode(input)))).toBe(expected);
  });

  it.each([55, 56, 57, 63, 64, 65, 119, 120, 121, 1000])(
    "agrees with the runtime's own MD5 on a %i-byte message",
    async (length) => {
      // The lengths either side of a block boundary are where padding goes
      // wrong; the bytes are fixed so the test cannot flake.
      const message = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256);

      expect(hex(md5(message))).toBe(hex(await runtimeMd5(message)));
    },
  );

  it("digests text beyond the Basic Multilingual Plane", async () => {
    const message = utf8.encode("Sigur Ros - Hoppipolla (live) \u{1f3b5}");

    expect(hex(md5(message))).toBe(hex(await runtimeMd5(message)));
  });
});

describe("newHashId", () => {
  it.each([
    ["test", "5cLJPkLA5DK2BADhoeotPk"],
    ["[unknown artist]", "7lsE5pS09fPS1VuFqwXbia"],
  ])("reproduces Navidrome's golden hash of %j", (input, expected) => {
    expect(newHashId(input)).toBe(expected);
  });

  it.each([
    ["one part", ["Aphex Twin"]],
    ["the parts an album is hashed from", ["aphex twin", "selected ambient works 85-92", "1992"]],
    ["an empty part", ["", "album", ""]],
    ["an R2 key", ["Aphex Twin/Selected Ambient Works 85-92/01 Xtal.mp3"]],
  ])("agrees with an independent implementation on %s", async (_label, parts) => {
    expect(newHashId(...parts)).toBe(await independentHashId(...parts));
  });

  it("pads a hash whose leading bytes are small to 22 characters", () => {
    // `pad-824` is one of the ~3% of inputs whose digest is small enough to
    // print in fewer than 22 base62 digits.
    expect(newHashId("pad-824")).toBe("00nDj5OIQocFLbBoZ4irjh");
  });

  it.each([
    "",
    "a",
    "Ludwig van Beethoven",
    "Prokofiev/Romeo & Juliet/02 The Montagues and the Capulets.flac",
  ])("always emits 22 base62 characters, for %j", (input) => {
    expect(newHashId(input)).toMatch(/^[0-9a-zA-Z]{22}$/);
  });

  it("separates the parts, so the same text split differently hashes differently", () => {
    expect(newHashId("a", "b")).not.toBe(newHashId("ab"));
    expect(newHashId("a", "b")).not.toBe(newHashId("ab", ""));
  });
});

describe("normalizeIdPart", () => {
  it("folds case", () => {
    expect(normalizeIdPart("Boards of Canada")).toBe("boards of canada");
  });

  it("folds typographic punctuation to ASCII, as Navidrome's str.Clear does", () => {
    expect(normalizeIdPart("\u201cWeird Al\u201d Yankovic")).toBe('"weird al" yankovic');
    expect(normalizeIdPart("\u2018Single\u2019 quotes")).toBe("'single' quotes");
    expect(normalizeIdPart("k\u2013os")).toBe("k-os");
    expect(normalizeIdPart("k\u2010os")).toBe("k-os");
  });

  it("folds only the five dashes Navidrome names, not a range between them", () => {
    // U+2013 to U+2212 spans most of General Punctuation, Arrows and Maths:
    // written as a range, every one of these would become a hyphen and two
    // different albums would share an id.
    expect(normalizeIdPart("a\u2026b")).not.toBe("a-b");
    expect(normalizeIdPart("a\u2022b")).not.toBe("a-b");
    expect(normalizeIdPart("a\u2192b")).not.toBe("a-b");
    expect(normalizeIdPart("a\u2020b")).not.toBe("a-b");
    expect(normalizeIdPart("a\u2026")).not.toBe(normalizeIdPart("a-"));
    expect(normalizeIdPart("a\u2026b")).toBe("a\u2026b");
  });

  it.each([
    ["\u2010", "hyphen"],
    ["\u2013", "en dash"],
    ["\u2014", "em dash"],
    ["\u2212", "minus sign"],
    ["\u2015", "horizontal bar"],
  ])("folds the %s (%s) to an ASCII hyphen", (dash) => {
    expect(normalizeIdPart(`k${dash}os`)).toBe("k-os");
  });

  it.each([
    ["\u2018", "\u2019"],
    ["\u201b", "\u2032"],
  ])("folds the single quotes %s and %s, and nothing between them", (open, close) => {
    expect(normalizeIdPart(`a${open}b${close}c`)).toBe("a'b'c");
    // U+201A and U+2020 sit inside the span these characters would cover.
    expect(normalizeIdPart("a\u201ab")).not.toBe("a'b");
  });

  it("removes a bidi control rather than folding it", () => {
    expect(normalizeIdPart("a\u200fb")).toBe("ab");
    expect(normalizeIdPart("a\u202eb")).toBe("ab");
    expect(normalizeIdPart("a\u2066b")).toBe("ab");
    expect(normalizeIdPart("a\u200fb")).not.toBe("a-b");
  });

  it("strips invisible characters", () => {
    expect(normalizeIdPart("Sig\u200bur R\u00f3s\ufeff")).toBe("sigur r\u00f3s");
    expect(normalizeIdPart("Sig\u00adur")).toBe("sigur");
    expect(normalizeIdPart("  Massive Attack  ")).toBe("massive attack");
  });

  it("keeps characters that do distinguish two names", () => {
    expect(normalizeIdPart("AC/DC")).toBe("ac/dc");
    expect(normalizeIdPart("Bj\u00f6rk")).toBe("bj\u00f6rk");
    expect(normalizeIdPart("Sigur R\u00f3s")).not.toBe(normalizeIdPart("Sigur Ros"));
  });
});

describe("the derivation rules", () => {
  it("derives a track id from its R2 key, taken literally", () => {
    const key = "Aphex Twin/Selected Ambient Works 85-92/01 Xtal.mp3";

    expect(trackId(1, key)).toBe(newHashId(key));
    // The key is an object's identity, so its case is part of it.
    expect(trackId(1, key)).not.toBe(trackId(1, key.toLowerCase()));
  });

  it("derives an album id from its album artist, name and year", () => {
    expect(albumId(1, "Aphex Twin", "Selected Ambient Works 85-92", 1992)).toBe(
      newHashId("aphex twin", "selected ambient works 85-92", "1992"),
    );
  });

  it("gives two albums of the same name by different artists different ids", () => {
    expect(albumId(1, "Weezer", "Weezer", 1994)).not.toBe(albumId(1, "Weezer", "Weezer", 2001));
    expect(albumId(1, "Nirvana", "Live", 1994)).not.toBe(albumId(1, "Pixies", "Live", 1994));
  });

  it("hashes a missing year as an empty part", () => {
    expect(albumId(1, "Artist", "Album")).toBe(newHashId("artist", "album", ""));
    expect(albumId(1, "Artist", "Album", null)).toBe(albumId(1, "Artist", "Album"));
    expect(albumId(1, "Artist", "Album", 0)).not.toBe(albumId(1, "Artist", "Album"));
  });

  it("derives an artist id from the normalized name", () => {
    expect(artistId("  Massive  Attack")).toBe(artistId("massive  attack"));
    expect(artistId("Massive Attack")).toBe(newHashId("massive attack"));
  });

  it("derives a playlist id from the R2 key of its .m3u", () => {
    expect(playlistId(1, "playlists/favourites.m3u")).toBe(newHashId("playlists/favourites.m3u"));
    expect(playlistId(1, "playlists/favourites.m3u")).not.toBe(
      playlistId(1, "playlists/favourites.m3u8"),
    );
  });

  it("leaves the prefix, not the hash, to say what kind an id is", () => {
    // Track, playlist and artist ids all hash a single part, so the same text
    // gives all three the same hash. Nothing depends on them differing: an id
    // only ever travels prefixed, and each kind is looked up in its own table.
    // The album hash, which takes three parts, stands apart anyway.
    expect(trackId(1, "name")).toBe(playlistId(1, "name"));
    expect(trackId(1, "name")).toBe(artistId("name"));
    expect(albumId(1, "name", "name", 2000)).not.toBe(trackId(1, "name"));
  });
});

describe("ids per library (ADR-0009)", () => {
  const KEY = "Aphex Twin/Selected Ambient Works 85-92/01 Xtal.mp3";
  const PLAYLIST_KEY = "playlists/favourites.m3u";

  it.each([
    // Recorded from v0.5.0 (`git show v0.5.0:packages/db/src/ids.ts`), and
    // recomputed outside this repository with Python's hashlib: the ids every
    // deployed track, album and playlist has, so every star, rating, play
    // count, playlist entry and play queue entry keeps pointing at its item.
    ["a track", () => trackId(1, KEY), "4uaX1IoB1jAUtkInpCNErX"],
    [
      "a track with non-ASCII in its key",
      () => trackId(1, "Sigur Rós/Ágætis byrjun/04 Svefn-g-englar.flac"),
      "2fQHO5jSWCIT2YiMMHCFWG",
    ],
    [
      "an album",
      () => albumId(1, "Aphex Twin", "Selected Ambient Works 85-92", 1992),
      "2QdrdJrQZQnQZiaAYJ6KYm",
    ],
    [
      "an album with no year",
      () => albumId(1, "Portishead", "Dummy", null),
      "6iK4xudqWx9l8EV07KRNNu",
    ],
    ["a playlist", () => playlistId(1, PLAYLIST_KEY), "50cZ3ijthLwMEy5bJBwWmR"],
    ["an artist", () => artistId("Aphex Twin"), "2mdKnMsw0wC3dWalkB0Ozr"],
  ])("keeps library 1's id of %s exactly as v0.5.0 minted it", (_label, derive, golden) => {
    expect(derive()).toBe(golden);
  });

  it("names the bound bucket's library 1", () => {
    expect(DEFAULT_LIBRARY_ID).toBe(1);
  });

  it("hashes any other library's id in as a leading part", () => {
    expect(trackId(2, KEY)).toBe(newHashId("2", KEY));
    expect(trackId(2, KEY)).toBe("5uCB0V1t4vj0qlj9VHRXHW");
    expect(albumId(2, "Aphex Twin", "Selected Ambient Works 85-92", 1992)).toBe(
      newHashId("2", "aphex twin", "selected ambient works 85-92", "1992"),
    );
    expect(albumId(2, "Portishead", "Dummy")).toBe(newHashId("2", "portishead", "dummy", ""));
    expect(playlistId(2, PLAYLIST_KEY)).toBe(newHashId("2", PLAYLIST_KEY));
    expect(trackId(12, KEY)).toBe(newHashId("12", KEY));
  });

  it("makes the same key two tracks, and the same playlist file two playlists, in two libraries", () => {
    expect(trackId(2, KEY)).not.toBe(trackId(1, KEY));
    expect(trackId(2, KEY)).not.toBe(trackId(3, KEY));
    expect(playlistId(2, PLAYLIST_KEY)).not.toBe(playlistId(1, PLAYLIST_KEY));
  });

  it("gives one album two ids in two libraries, and its artist one", () => {
    const tags = ["Aphex Twin", "Selected Ambient Works 85-92", 1992] as const;

    expect(albumId(1, ...tags)).not.toBe(albumId(2, ...tags));
    // Artists take no library: one artist in both is one artist.
    expect(artistId(tags[0])).toBe("2mdKnMsw0wC3dWalkB0Ozr");
  });

  it("can collide with library 1 only through a key that begins with the library's part", () => {
    // The crafted collision the upserts guard against (scanner/repository.ts,
    // playlists/repository.ts): a library-1 key that is library 2's id part
    // and its separator in front of the other key.
    expect(trackId(1, `2​${KEY}`)).toBe(trackId(2, KEY));
    expect(playlistId(1, `2​${PLAYLIST_KEY}`)).toBe(playlistId(2, PLAYLIST_KEY));
    // An album name cannot carry the separator: it is stripped as invisible.
    expect(albumId(1, "2​Aphex Twin", "Selected Ambient Works 85-92", 1992)).not.toBe(
      albumId(2, "Aphex Twin", "Selected Ambient Works 85-92", 1992),
    );
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses %d as a library id", (libraryId) => {
    expect(() => trackId(libraryId, KEY)).toThrow(/library id/);
    expect(() => albumId(libraryId, "a", "b")).toThrow(/library id/);
    expect(() => playlistId(libraryId, PLAYLIST_KEY)).toThrow(/library id/);
  });
});

describe("prefixed ids", () => {
  const id = artistId("Massive Attack");

  it.each([
    ["artist", "ar-"],
    ["album", "al-"],
    ["track", "tr-"],
    ["playlist", "pl-"],
  ] as const)("round-trips a %s id through its %s prefix", (type, prefix) => {
    const prefixed = prefixedId(type, id);

    expect(prefixed).toBe(prefix + id);
    expect(parsePrefixedId(prefixed)).toEqual({ type, id });
    expect(parseIdOfType(type, prefixed)).toBe(id);
  });

  it("names every kind of entity", () => {
    expect(Object.values(ENTITY_ID_PREFIXES)).toEqual(["ar-", "al-", "tr-", "pl-"]);
  });

  it("accepts the largest id there is", () => {
    // 16 bytes of 0xff, the value just inside the limit.
    const largest = "7N42dgm5tFLK9N8MT7fHC7";

    expect(parsePrefixedId(`tr-${largest}`)).toEqual({ type: "track", id: largest });
    expect(parsePrefixedId("tr-7N42dgm5tFLK9N8MT7fHC8")).toBeNull();
  });

  it("does not read an id of one kind as another", () => {
    expect(parseIdOfType("album", prefixedId("artist", id))).toBeNull();
  });

  it.each([
    ["nothing", ""],
    ["a bare id", "3Zo4nA5cLJPkLA5DKBADho"],
    ["an unknown prefix", `xx-${id}`],
    ["a prefix alone", "al-"],
    ["a truncated id", `al-${id.slice(1)}`],
    ["an overlong id", `al-${id}0`],
    ["punctuation in the id", `al-${id.slice(0, 21)}!`],
    ["a path traversal", "al-../../etc/passwd"],
    ["an SQL fragment", "tr-' OR 1=1 --"],
    ["a double prefix", `al-ar-${id}`],
    // 22 base62 digits, but a number larger than 16 bytes can hold, so no id
    // was ever minted for it - Navidrome's id.Decode refuses it too.
    ["a base62 number too large to be an id", "al-zzzzzzzzzzzzzzzzzzzzzz"],
  ])("rejects %s", (_label, value) => {
    expect(parsePrefixedId(value)).toBeNull();
    expect(parseIdOfType("album", value)).toBeNull();
  });
});
