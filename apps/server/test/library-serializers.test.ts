import { type Album, albumId, artistId, trackId } from "@stratosonic/db";
import { describe, expect, it } from "vitest";
import {
  albumElement,
  artistElement,
  genreElement,
  omitWhenEmpty,
  type SongView,
  songElement,
  subsonicTimestamp,
} from "../src/library/serializers";
import { renderSubsonicResponse, type SubsonicNode } from "../src/subsonic/response";

/**
 * The shared element builders on their own. Every endpoint that answers with
 * an artist, an album, a song or a genre renders it through these, so the
 * rules that clients are strict about — the literal `isDir`, the millisecond
 * timestamp, the omitted `coverArt`, the attribute order — are pinned here
 * rather than once per endpoint.
 *
 * Each case renders the element the way the Worker does, so what is asserted
 * is the text a client receives, attribute order included.
 */

const CREATED_AT = new Date("2023-11-14T22:13:20.123Z");

const ALBUM_ARTIST = "Mute Ensemble";
const ALBUM_NAME = "Faststart Sessions";

function albumRow(overrides: Partial<Album> = {}): Album {
  const year = overrides.year === undefined ? 2019 : overrides.year;

  return {
    id: albumId(ALBUM_ARTIST, ALBUM_NAME, year),
    name: ALBUM_NAME,
    artistId: artistId(ALBUM_ARTIST),
    albumArtist: ALBUM_ARTIST,
    year,
    genre: "Ambient",
    songCount: 2,
    duration: 431.6,
    size: 6356,
    coverKey: `_covers/${albumId(ALBUM_ARTIST, ALBUM_NAME, year)}.png`,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function songRow(overrides: Partial<SongView> = {}): SongView {
  const r2Key = `${ALBUM_ARTIST}/${ALBUM_NAME}/01 Front Loaded.m4a`;
  const album = albumRow();

  return {
    id: trackId(r2Key),
    r2Key,
    title: "Front Loaded",
    albumId: album.id,
    artistId: album.artistId,
    artist: ALBUM_ARTIST,
    albumArtist: ALBUM_ARTIST,
    trackNumber: 1,
    discNumber: 1,
    year: 2019,
    duration: 215.8,
    bitRate: 22,
    size: 3179,
    suffix: "m4a",
    genre: "Ambient",
    etag: "etag-front-loaded",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    albumName: album.name,
    albumCoverKey: album.coverKey,
    ...overrides,
  };
}

/** The element as the Worker would send it, taken out of its envelope. */
async function render(name: string, element: SubsonicNode): Promise<string> {
  const xml = await renderSubsonicResponse(
    { status: "ok", body: { [name]: element } },
    "xml",
  ).text();

  return xml.slice(xml.indexOf(`<${name}`), xml.lastIndexOf("</subsonic-response>"));
}

describe("artistElement", () => {
  const artist = {
    id: artistId(ALBUM_ARTIST),
    name: ALBUM_ARTIST,
    albumCount: 3,
    coverAlbumId: albumId(ALBUM_ARTIST, ALBUM_NAME, 2019),
  };

  it("carries a prefixed id, the name, the cover and the count, in that order", async () => {
    expect(await render("artist", artistElement(artist))).toBe(
      `<artist id="ar-${artist.id}" name="${ALBUM_ARTIST}" coverArt="al-${artist.coverAlbumId}" albumCount="3"/>`,
    );
  });

  it("omits coverArt when no album of the artist has one", async () => {
    const element = await render("artist", artistElement({ ...artist, coverAlbumId: null }));

    expect(element).not.toContain("coverArt");
  });

  it("still reports an album count of zero", async () => {
    const element = await render("artist", artistElement({ ...artist, albumCount: 0 }));

    expect(element).toContain('albumCount="0"');
  });
});

describe("albumElement", () => {
  it("carries every attribute Navidrome's AlbumID3 declares, in its order", async () => {
    const album = albumRow();

    expect(await render("album", albumElement(album))).toBe(
      `<album id="al-${album.id}" name="${ALBUM_NAME}" artist="${ALBUM_ARTIST}"` +
        ` artistId="ar-${album.artistId}" coverArt="al-${album.id}" songCount="2"` +
        ` duration="431" created="2023-11-14T22:13:20.123Z" year="2019" genre="Ambient"/>`,
    );
  });

  it("omits coverArt, year and genre when the album has none", async () => {
    const element = await render(
      "album",
      albumElement(albumRow({ coverKey: null, year: null, genre: null })),
    );

    expect(element).not.toContain("coverArt");
    expect(element).not.toContain("year");
    expect(element).not.toContain("genre");
  });

  it("treats a year of zero as no year, as omitempty does", async () => {
    expect(await render("album", albumElement(albumRow({ year: 0 })))).not.toContain("year");
  });

  it("keeps a song count and a duration of zero, which are not optional", async () => {
    const element = await render("album", albumElement(albumRow({ songCount: 0, duration: 0 })));

    expect(element).toContain('songCount="0"');
    expect(element).toContain('duration="0"');
  });
});

describe("songElement", () => {
  it("carries every attribute Navidrome's Child declares for a song, in its order", async () => {
    const song = songRow();

    expect(await render("song", songElement(song))).toBe(
      `<song id="tr-${song.id}" parent="al-${song.albumId}" isDir="false" title="Front Loaded"` +
        ` album="${ALBUM_NAME}" artist="${ALBUM_ARTIST}" track="1" year="2019" genre="Ambient"` +
        ` coverArt="al-${song.albumId}" size="3179" contentType="audio/mp4" suffix="m4a"` +
        ` duration="215" bitRate="22" path="${song.r2Key}" discNumber="1"` +
        ` created="2023-11-14T22:13:20.123Z" albumId="al-${song.albumId}"` +
        ` artistId="ar-${song.artistId}" type="music"/>`,
    );
  });

  it("writes isDir as the literal false, never 0", async () => {
    expect(await render("song", songElement(songRow()))).toContain('isDir="false"');
  });

  it("omits coverArt when the song's album has none", async () => {
    const element = await render("song", songElement(songRow({ albumCoverKey: null })));

    expect(element).not.toContain("coverArt");
  });

  it("omits the numbers a track does not have, as omitempty would", async () => {
    const element = await render(
      "song",
      songElement(
        songRow({ trackNumber: null, discNumber: null, year: null, bitRate: 0, genre: null }),
      ),
    );

    expect(element).not.toContain("track=");
    expect(element).not.toContain("discNumber");
    expect(element).not.toContain("year");
    expect(element).not.toContain("bitRate");
    expect(element).not.toContain("genre");
  });

  it("truncates the duration to whole seconds, as Navidrome does", async () => {
    expect(await render("song", songElement(songRow({ duration: 59.9 })))).toContain(
      'duration="59"',
    );
  });

  it("reads the content type from the suffix map", async () => {
    expect(await render("song", songElement(songRow({ suffix: "flac" })))).toContain(
      'contentType="audio/flac"',
    );
    expect(await render("song", songElement(songRow({ suffix: "mp3" })))).toContain(
      'contentType="audio/mpeg"',
    );
  });

  it("leaves the content type out for a suffix the server does not serve", async () => {
    expect(await render("song", songElement(songRow({ suffix: "ogg" })))).not.toContain(
      "contentType",
    );
  });

  it("escapes the characters that would otherwise break the document", async () => {
    const element = await render(
      "song",
      songElement(songRow({ title: `Rock & Roll <"Live"> 'Take 2'` })),
    );

    expect(element).toContain(
      `title="Rock &amp; Roll &lt;&quot;Live&quot;&gt; &apos;Take 2&apos;"`,
    );
  });
});

describe("genreElement", () => {
  it("puts the name in the element's text and the counts in attributes", async () => {
    const element = genreElement({ name: "Drum & Bass", songCount: 3, albumCount: 1 });

    expect(await render("genre", element)).toBe(
      `<genre songCount="3" albumCount="1">Drum &amp; Bass</genre>`,
    );
  });

  it("carries the name as `value` in JSON, as Navidrome's Genre does", async () => {
    const body = {
      genres: { genre: [genreElement({ name: "Jazz", songCount: 2, albumCount: 2 })] },
    };
    const json = (await renderSubsonicResponse({ status: "ok", body }, "json").json()) as {
      "subsonic-response": { genres: { genre: { value: string }[] } };
    };

    expect(json["subsonic-response"].genres.genre).toEqual([
      { value: "Jazz", songCount: 2, albumCount: 2 },
    ]);
  });
});

describe("subsonicTimestamp", () => {
  it("writes milliseconds even when the instant has none", () => {
    expect(subsonicTimestamp(new Date(1_700_000_000_000))).toBe("2023-11-14T22:13:20.000Z");
  });
});

describe("omitWhenEmpty", () => {
  it("keeps a list that has something in it", () => {
    expect(omitWhenEmpty([1, 2])).toEqual([1, 2]);
  });

  it("drops an empty one, so the element is rendered without children", () => {
    expect(omitWhenEmpty([])).toBeUndefined();
  });
});
