/**
 * What an audio object says about itself, read from its header alone.
 *
 * The scan never downloads a track. It hands this module a `ByteSource` over
 * the object and the suffix the key ends in, and gets back the Track fields
 * the library stores: the tags, the numbers a duration is derived from, and
 * the first embedded picture. Nothing here touches R2, D1 or the Worker's
 * environment - the scanner does the reading, this decides what to read.
 *
 * Parsing is `music-metadata` driven through `ByteSourceTokenizer`, so the
 * library seeks rather than streams: it reads an ID3v2 tag or a FLAC block
 * chain at the head, an MP4 `moov` wherever it sits, and an ID3v1 tag at the
 * tail, and steps over the audio body without reading it. Its full-scan
 * duration option stays off, so a duration is always derived:
 *
 * - **MP3** from the Xing/Info frame when the encoder wrote one, else the
 *   constant-bit-rate estimate, audio bytes x 8 / bit rate;
 * - **FLAC** from STREAMINFO, `total_samples / sample_rate`;
 * - **MP4** from `mvhd`/`mdhd`, `duration / timescale`.
 *
 * A file whose header does not say is worth 0 rather than a lie.
 */

import { parseFromTokenizer } from "music-metadata";
import { AUDIO_CONTENT_TYPES, type AudioSuffix, isAudioSuffix } from "./audio-formats";
import { type ByteSource, chunkedSource } from "./byte-source";
import { ByteSourceTokenizer } from "./source-tokenizer";

/** An image carried inside a track. */
export interface EmbeddedCover {
  /** The image's own MIME type, as the tag declares it, e.g. `image/jpeg`. */
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/**
 * A track as its own bytes describe it.
 *
 * A tag the file does not carry is `undefined`, never `"Unknown"` and never an
 * empty string: what a missing album artist or title should fall back to is
 * the R2 key, which this module does not know and the scanner does.
 */
export interface TrackMetadata {
  readonly title?: string;
  /** The track artist, which may differ from the album artist. */
  readonly artist?: string;
  readonly albumArtist?: string;
  readonly album?: string;
  readonly trackNumber?: number;
  readonly discNumber?: number;
  readonly year?: number;
  /** The first genre named, which is the one the library stores. */
  readonly genre?: string;
  /** Seconds, fractional, derived from the header; 0 when it does not say. */
  readonly duration: number;
  /** Kilobits per second, rounded, as Subsonic reports it; 0 when unknown. */
  readonly bitRate: number;
  /** Hertz, when the header states it. */
  readonly sampleRate?: number;
  /** The first picture embedded in the track, if it carries one. */
  readonly cover?: EmbeddedCover;
}

export type MetadataErrorCode =
  /** The key's suffix is not one of the formats this can read. */
  | "unsupported-format"
  /** The bytes are not the format the suffix promised, or are cut short. */
  | "unreadable";

/**
 * Why a track could not be described.
 *
 * The scan meets both of these in a bucket someone uploads to by hand, and
 * neither should end a run: it counts the object as unreadable and moves on,
 * which it can only do if the failure arrives as this rather than as whatever
 * a parser happened to throw.
 */
export class MetadataError extends Error {
  readonly code: MetadataErrorCode;

  constructor(code: MetadataErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MetadataError";
    this.code = code;
  }
}

export interface ExtractOptions {
  /**
   * Bytes per underlying read. The default suits a real track; a test that
   * wants to see which regions of a small fixture were touched lowers it.
   */
  readonly chunkSize?: number;
}

/**
 * Reads the metadata of an audio object from its bytes.
 *
 * `suffix` is the key's extension, lower case and without the dot. It is both
 * the allowlist check and what tells the parser which format to expect: naming
 * the content type up front means the parser never sniffs, so the first read
 * is the header itself rather than a blind read of the first kilobytes.
 *
 * The source is wrapped in `chunkedSource` here, so a caller passes the plain
 * range-reading source and still pays only a handful of reads.
 */
export async function extractMetadata(
  source: ByteSource,
  suffix: string,
  options: ExtractOptions = {},
): Promise<TrackMetadata> {
  if (!isAudioSuffix(suffix)) {
    throw new MetadataError("unsupported-format", `no metadata reader for a .${suffix} object`);
  }
  if (source.size <= 0) {
    throw new MetadataError("unreadable", "the object is empty");
  }

  const tokenizer = new ByteSourceTokenizer(
    chunkedSource(source, { chunkSize: options.chunkSize }),
    AUDIO_CONTENT_TYPES[suffix satisfies AudioSuffix],
  );

  try {
    const { common, format } = await parseFromTokenizer(tokenizer, {
      // Never walk the whole file to measure a duration: derive it, or do
      // without. This is the option that keeps a scan inside its budget.
      duration: false,
      skipCovers: false,
    });

    const metadata: TrackMetadata = {
      ...defined("title", text(common.title)),
      ...defined("artist", text(common.artist)),
      ...defined("albumArtist", text(common.albumartist)),
      ...defined("album", text(common.album)),
      ...defined("trackNumber", counting(common.track?.no)),
      ...defined("discNumber", counting(common.disk?.no)),
      ...defined("year", counting(common.year)),
      ...defined("genre", text(common.genre?.[0])),
      duration: finite(format.duration) ?? 0,
      bitRate: Math.round((finite(format.bitrate) ?? 0) / 1000),
      ...defined("sampleRate", finite(format.sampleRate)),
      ...defined("cover", firstCover(common.picture)),
    };

    // A parser handed bytes that are not the format their suffix promised
    // does not always object: it looks for a header, finds none, and returns
    // an empty description. An object that says nothing at all about itself
    // is not a track, and the scan must hear that as a failure rather than
    // index a silent, nameless, zero-length one.
    if (!describesAnything(metadata)) {
      throw new MetadataError(
        "unreadable",
        `the object's bytes do not describe a .${suffix} stream`,
      );
    }

    return metadata;
  } catch (cause) {
    if (cause instanceof MetadataError) {
      throw cause;
    }

    throw new MetadataError("unreadable", `could not read the .${suffix} object`, { cause });
  } finally {
    await tokenizer.close();
  }
}

/** Whether the parse found anything: a tag, a picture, or format numbers. */
function describesAnything(metadata: TrackMetadata): boolean {
  const { duration, bitRate, ...rest } = metadata;

  return duration > 0 || bitRate > 0 || Object.keys(rest).length > 0;
}

/** The first picture the file carries, which is the one an album takes. */
function firstCover(
  pictures: readonly { format: string; data: Uint8Array }[] | undefined,
): EmbeddedCover | undefined {
  const picture = pictures?.[0];
  if (!picture || picture.data.length === 0) {
    return undefined;
  }

  const mimeType = picture.format.trim();

  return mimeType === "" ? undefined : { mimeType, bytes: picture.data };
}

/** A tag that is present but blank says nothing, so it is absent. */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** A track, disc or year number, which is absent unless it is a real count. */
function counting(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finite(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Spreads a field only when it has a value, so a missing tag stays missing. */
function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}
