/**
 * The audio formats Stratosonic serves.
 *
 * This map does two jobs, deliberately as one constant:
 *
 * - it is the **allowlist** — the scan indexes an R2 object only if its suffix
 *   is a key here, so anything else in the bucket (artwork, `.m3u` playlists,
 *   stray files) is never mistaken for a track;
 * - it is the **content type** of a track. `contentType` is not a column: a
 *   track's suffix is stored and its MIME type is looked up here, by `stream`,
 *   by `download` and by the `<song>` serializer alike.
 *
 * Only formats the metadata extractor can read belong here. Adding one means
 * teaching the extractor to read its tags and derive its duration first;
 * otherwise the scan would index files it cannot describe.
 *
 * The MIME types are Navidrome's, from `resources/mime_types.yaml`.
 */
export const AUDIO_CONTENT_TYPES = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  flac: "audio/flac",
} as const;

/** A suffix Stratosonic indexes and serves. */
export type AudioSuffix = keyof typeof AUDIO_CONTENT_TYPES;

export const AUDIO_SUFFIXES = Object.keys(AUDIO_CONTENT_TYPES) as readonly AudioSuffix[];

/**
 * The suffix of an R2 key, lower-cased and without the dot: `""` when the key
 * has no extension, or when the last dot belongs to a directory rather than to
 * the file name.
 */
export function suffixOf(r2Key: string): string {
  const name = r2Key.slice(r2Key.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");

  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Whether the scan should index an object with this suffix.
 *
 * The lookup asks for an own property: `in` would also find what every object
 * inherits, making `constructor` and `toString` audio formats whose content
 * type is a function.
 */
export function isAudioSuffix(suffix: string): suffix is AudioSuffix {
  return Object.hasOwn(AUDIO_CONTENT_TYPES, suffix);
}

/** Whether this R2 key names a track. */
export function isAudioKey(r2Key: string): boolean {
  return isAudioSuffix(suffixOf(r2Key));
}

/** The content type of a stored track, from the suffix stored with it. */
export function audioContentType(suffix: string): string | null {
  return isAudioSuffix(suffix) ? AUDIO_CONTENT_TYPES[suffix] : null;
}
