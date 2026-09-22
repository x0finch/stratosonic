/**
 * Finding a track's lyrics in the bucket: the sidecar file beside it.
 *
 * Nothing is indexed. As Navidrome's `fromExternalFile`
 * (core/lyrics/sources.go) opens the file at request time, this reads the
 * sidecar from R2 when a client asks, so the scan keeps ignoring sidecars and
 * serving lyrics writes nothing to D1.
 */

import type { Env } from "../env";
import { decodeLyrics, type ParsedLyrics, parseLrc, UNKNOWN_LANGUAGE } from "./lrc";

/**
 * The sidecar suffixes, in the order they are tried: Navidrome's default
 * `LyricsPriority` without its `embedded` source, which this server does not
 * read.
 */
export const SIDECAR_SUFFIXES: readonly string[] = [".lrc", ".txt"];

/**
 * The largest sidecar read, one MiB. A lyrics file is a few kilobytes; one
 * bigger than this is not lyrics, and reading it would spend the request's
 * memory and CPU on it. It is the cap Navidrome puts on a lyrics tag.
 */
export const MAX_SIDECAR_BYTES = 1024 * 1024;

/**
 * The key of a track's sidecar with this suffix: the track's key with its
 * extension replaced, as Go's `path.Ext` finds it - the last dot of the last
 * segment, so `…/04 Song.mp3` has its sidecar at `…/04 Song.lrc`.
 */
export function sidecarKey(trackKey: string, suffix: string): string {
  const name = trackKey.slice(trackKey.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot < 0 ? trackKey : trackKey.slice(0, trackKey.length - (name.length - dot));

  return `${stem}${suffix}`;
}

/**
 * The lyrics of the track stored under this key, or null when it has none.
 *
 * Each suffix is tried in turn and the first sidecar that yields a line
 * wins, so an empty `.lrc` does not hide a `.txt`: one R2 read per suffix at
 * most, two in all.
 */
export async function readSidecarLyrics(env: Env, trackKey: string): Promise<ParsedLyrics | null> {
  for (const suffix of SIDECAR_SUFFIXES) {
    const lyrics = await readSidecarLyricsWithSuffix(env, trackKey, suffix);

    if (lyrics !== null) {
      return lyrics;
    }
  }

  return null;
}

/**
 * The lyrics in the one sidecar of this suffix beside a track, or null when
 * it is absent, unreadable, too large or holds no line: one R2 read.
 *
 * `getLyrics` needs this on its own because Navidrome's
 * `getLyricsForCandidates` tries each source across every candidate before
 * the next source, so it walks the suffixes itself.
 */
export async function readSidecarLyricsWithSuffix(
  env: Env,
  trackKey: string,
  suffix: string,
): Promise<ParsedLyrics | null> {
  const text = await readSidecarText(env, sidecarKey(trackKey, suffix));

  return text === null ? null : parseLrc(text, UNKNOWN_LANGUAGE);
}

/**
 * The text of one sidecar, or null when there is none to read.
 *
 * An object R2 fails to produce is logged and treated as absent, as a missing
 * file is: lyrics are an extra, and a client asking for them must get an
 * empty answer rather than an error it would show the listener.
 */
async function readSidecarText(env: Env, key: string): Promise<string | null> {
  try {
    const object = await env.MUSIC.get(key);
    if (object === null) {
      return null;
    }

    if (object.size > MAX_SIDECAR_BYTES) {
      // The body is let go unread rather than left for the runtime to drain.
      // Local runs (workerd) log the cancelled transfer as "pump canceled".
      console.warn(`lyrics: ignoring ${key}, which is ${object.size} bytes`);
      await object.body.cancel();

      return null;
    }

    return decodeLyrics(new Uint8Array(await object.arrayBuffer()));
  } catch (error) {
    console.warn(`lyrics: could not read ${key}; answering without it`, error);

    return null;
  }
}
