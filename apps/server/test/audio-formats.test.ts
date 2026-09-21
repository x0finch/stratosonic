import { describe, expect, it } from "vitest";
import {
  AUDIO_CONTENT_TYPES,
  AUDIO_SUFFIXES,
  audioContentType,
  isAudioKey,
  isAudioSuffix,
  suffixOf,
} from "../src/library/audio-formats";

describe("the audio format map", () => {
  it.each([
    ["mp3", "audio/mpeg"],
    ["m4a", "audio/mp4"],
    ["flac", "audio/flac"],
  ])("serves %s as %s, the type Navidrome serves it as", (suffix, contentType) => {
    expect(audioContentType(suffix)).toBe(contentType);
  });

  it("is the one allowlist: every suffix it serves it also indexes", () => {
    expect(AUDIO_SUFFIXES).toEqual(Object.keys(AUDIO_CONTENT_TYPES));

    for (const suffix of AUDIO_SUFFIXES) {
      expect(isAudioSuffix(suffix)).toBe(true);
      expect(audioContentType(suffix)).toBe(AUDIO_CONTENT_TYPES[suffix]);
    }
  });

  it.each(["m3u", "m3u8", "jpg", "png", "txt", "ogg", "wav", "", "mp4"])(
    "does not index %j",
    (suffix) => {
      expect(isAudioSuffix(suffix)).toBe(false);
      expect(audioContentType(suffix)).toBeNull();
    },
  );

  it("matches a suffix whatever case it is written in", () => {
    expect(isAudioKey("Artist/Album/Track.FLAC")).toBe(true);
    expect(suffixOf("Artist/Album/Track.Mp3")).toBe("mp3");
  });

  it.each([
    ["Artist/Album/01 Track.mp3", "mp3"],
    ["Artist/Album/01 Track.tar.gz", "gz"],
    ["playlists/favourites.m3u", "m3u"],
    ["_covers/al-000.png", "png"],
    ["Artist/Album/no-extension", ""],
    ["Artist/Album.with.dots/track", ""],
    [".hidden", ""],
    ["", ""],
  ])("reads the suffix of %j as %j", (key, suffix) => {
    expect(suffixOf(key)).toBe(suffix);
  });

  it("keeps the scan off everything that is not a track", () => {
    expect(isAudioKey("Silent Artist/Quiet Album/01 Silent Track.mp3")).toBe(true);
    expect(isAudioKey("playlists/favourites.m3u")).toBe(false);
    expect(isAudioKey("_covers/al-0000000000000000000000.png")).toBe(false);
    expect(isAudioKey("folder.jpg")).toBe(false);
  });
});
