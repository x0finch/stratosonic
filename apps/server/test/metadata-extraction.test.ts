import { describe, expect, it } from "vitest";
import { bytesSource } from "../src/library/byte-source";
import { extractMetadata, type TrackMetadata } from "../src/library/metadata";
import { type FixtureTrack, fixtureBytes, fixtures, fixtureTrack } from "./fixtures/files";

/**
 * What a track's own bytes say, read the way the scan will read them.
 *
 * Every expectation here comes from `manifest.json`, which the generator
 * writes: the tags each fixture carries, the duration and which of the three
 * rules yields it, the bit rate, and the cover. Nothing is restated.
 */

function extract(track: FixtureTrack, chunkSize?: number): Promise<TrackMetadata> {
  return extractMetadata(bytesSource(fixtureBytes(track.file)), track.suffix, { chunkSize });
}

describe.each(fixtures.tracks.map((track) => [track.file, track] as const))(
  "reading %s",
  (_file, track) => {
    it("reports the tags the manifest says it carries", async () => {
      const { tags } = track;
      const metadata = await extract(track);

      expect({
        title: metadata.title,
        artist: metadata.artist,
        albumArtist: metadata.albumArtist,
        album: metadata.album,
        trackNumber: metadata.trackNumber,
        discNumber: metadata.discNumber,
        year: metadata.year,
        genre: metadata.genre,
      }).toEqual(
        tags === null
          ? {
              title: undefined,
              artist: undefined,
              albumArtist: undefined,
              album: undefined,
              trackNumber: undefined,
              discNumber: undefined,
              year: undefined,
              genre: undefined,
            }
          : {
              title: tags.title,
              artist: tags.artist,
              albumArtist: tags.albumArtist,
              album: tags.album,
              trackNumber: tags.trackNumber,
              discNumber: tags.discNumber,
              year: tags.year,
              genre: tags.genre,
            },
      );
    });

    it("reports a duration within the tolerance the manifest states", async () => {
      const { seconds, toleranceSeconds } = track.duration;

      expect((await extract(track)).duration).toBeCloseTo(
        seconds,
        // `toBeCloseTo` counts decimal places, and the manifest states a
        // tolerance in seconds; the smallest number of places that is at
        // least as strict is what the tolerance asks for.
        Math.floor(-Math.log10(2 * toleranceSeconds)),
      );
    });

    it("reports the bit rate in kilobits per second", async () => {
      expect((await extract(track)).bitRate).toBe(track.bitRate.kbps);
    });

    it("reports the sample rate its header states", async () => {
      expect((await extract(track)).sampleRate).toBe(44_100);
    });

    it("returns the embedded cover, or none where there is none", async () => {
      const { cover } = await extract(track);

      if (track.cover === null) {
        expect(cover).toBeUndefined();
        return;
      }

      expect(cover?.mimeType).toBe(track.cover.mimeType);
      expect(cover?.bytes).toHaveLength(track.cover.size);
    });

    it("never says a tag is unknown", async () => {
      // Every absent tag is absent, not the string a client would then show.
      expect(Object.values(await extract(track))).not.toContain("Unknown");
    });
  },
);

describe("the cover", () => {
  it("is the very image the fixtures embed", async () => {
    const { cover } = await extract(fixtureTrack("silent-track.mp3"));

    expect(cover?.bytes).toEqual(fixtureBytes(fixtures.cover.file));
  });

  it("comes back from the FLAC picture block too", async () => {
    const { cover } = await extract(fixtureTrack("hushed-interlude.flac"));

    expect(cover?.mimeType).toBe("image/png");
    expect(cover?.bytes).toEqual(fixtureBytes(fixtures.cover.file));
  });
});
