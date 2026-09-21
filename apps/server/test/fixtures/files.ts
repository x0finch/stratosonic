/**
 * The committed fixture files, as bytes a test can read.
 *
 * They are imported through Vite - `?inline` for the audio, `?raw` for the
 * playlist text - because the tests run inside workerd, where there is no file
 * system to read them from. `manifest.json` travels with them and says what
 * each one contains; nothing else should restate those expectations.
 */

import type { FixturesManifest, FixtureTrack } from "./build";
import coverPng from "./cover.png?inline";
import playlistText from "./favourites.m3u?raw";
import frontLoaded from "./front-loaded.m4a?inline";
import hushedInterlude from "./hushed-interlude.flac?inline";
import manifestJson from "./manifest.json";
import silentTrack from "./silent-track.mp3?inline";
import tailLoaded from "./tail-loaded.m4a?inline";
import untagged from "./untagged.mp3?inline";

export type {
  FixtureAlbum,
  FixtureCover,
  FixturePlaylist,
  FixturePlaylistLine,
  FixturesManifest,
  FixtureTags,
  FixtureTrack,
} from "./build";

/** What the fixtures contain, written by the generator that made them. */
export const fixtures = manifestJson as FixturesManifest;

const BINARY: Readonly<Record<string, string>> = {
  "silent-track.mp3": silentTrack,
  "hushed-interlude.flac": hushedInterlude,
  "front-loaded.m4a": frontLoaded,
  "tail-loaded.m4a": tailLoaded,
  "untagged.mp3": untagged,
  "cover.png": coverPng,
};

/** The text of the `.m3u` fixture, exactly as committed. */
export const fixturePlaylistText = playlistText;

/** The bytes of one fixture file, by the name the manifest gives it. */
export function fixtureBytes(file: string): Uint8Array {
  if (file === fixtures.playlist.file) {
    return new TextEncoder().encode(fixturePlaylistText);
  }

  const dataUri = BINARY[file];
  if (!dataUri) {
    throw new Error(`no fixture named ${file}`);
  }

  return decodeBase64(dataUri.slice(dataUri.indexOf(",") + 1));
}

/** The cover image the tagged fixtures embed, as its own bytes. */
export function fixtureCoverBytes(): Uint8Array {
  return fixtureBytes(fixtures.cover.file);
}

/** The track fixture with this file name, or the R2 key it is stored under. */
export function fixtureTrack(fileOrKey: string): FixtureTrack {
  const track = fixtures.tracks.find(
    (candidate) => candidate.file === fileOrKey || candidate.r2Key === fileOrKey,
  );
  if (!track) {
    throw new Error(`no track fixture named ${fileOrKey}`);
  }

  return track;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
