/**
 * Reading part of a stored object, without reading the object.
 *
 * A track in the bucket is an audio file of a few megabytes, but everything
 * the library needs to know about it - its tags, its cover, the numbers a
 * duration is derived from - sits in a few kilobytes of header. A `ByteSource`
 * is the one thing the metadata extractor is given: a size, and a way to ask
 * for a range. The scanner backs it with R2 `get()` range requests; a test
 * backs it with bytes it already holds. Nothing downstream of this interface
 * knows which.
 *
 * Every underlying read is a Cloudflare subrequest, and a scheduled run has a
 * budget of them, so `chunkedSource` sits between the parser - which asks for
 * four bytes at a time - and the object, and turns those many small reads into
 * a handful of large ones.
 */

/** A stored object of a known size, readable a range at a time. */
export interface ByteSource {
  /** The object's length in bytes. */
  readonly size: number;
  /**
   * The bytes in `[offset, offset + length)`, clamped to the object's end:
   * the result is shorter than `length` only when the range runs past the
   * end, and empty when it starts at or past it.
   *
   * The bytes are read-only. An implementation may hand back a view of a
   * buffer it keeps, so a caller that needs to modify them copies first.
   */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * How much `chunkedSource` reads at a time, and how much it keeps.
 *
 * 256 KiB is chosen against what a header actually costs: an ID3v2 tag with an
 * embedded cover is commonly 100-300 KB, so one chunk usually holds the whole
 * head of a file, and a second holds the tail an MP4 with a trailing `moov`
 * needs. Smaller chunks would split a cover across several subrequests;
 * larger ones would read megabytes to find a 128-byte ID3v1 tag.
 *
 * Eight cached chunks bound the memory one track's parse can hold to 2 MiB,
 * which is far more than any parse here reaches and still nothing next to the
 * Worker's memory limit.
 */
export const DEFAULT_CHUNK_SIZE = 256 * 1024;
export const DEFAULT_CACHED_CHUNKS = 8;

export interface ChunkedSourceOptions {
  /** Bytes per underlying read. Must be at least 1. */
  readonly chunkSize?: number;
  /** How many chunks to keep; the least recently used one is dropped first. */
  readonly maxCachedChunks?: number;
}

/**
 * Wraps a source so that reads are served from aligned, cached chunks.
 *
 * A parser walks a header in small steps - a four-byte atom size, an
 * eight-byte header, a tag frame - and each step would otherwise be its own
 * range request. Here the first step pulls the chunk it falls in and the rest
 * are served from memory, so a whole parse costs a handful of reads: the chunk
 * the head is in, and the chunk the tail is in when the format keeps its
 * metadata there.
 */
export function chunkedSource(source: ByteSource, options: ChunkedSourceOptions = {}): ByteSource {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const maxCachedChunks = options.maxCachedChunks ?? DEFAULT_CACHED_CHUNKS;

  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  if (!Number.isInteger(maxCachedChunks) || maxCachedChunks < 1) {
    throw new RangeError(`maxCachedChunks must be a positive integer, got ${maxCachedChunks}`);
  }

  // Insertion order is recency order: a chunk that is used again is deleted
  // and re-set, so the first key is always the least recently used one.
  const cache = new Map<number, Uint8Array>();

  async function chunkAt(index: number): Promise<Uint8Array> {
    const cached = cache.get(index);
    if (cached) {
      cache.delete(index);
      cache.set(index, cached);

      return cached;
    }

    const start = index * chunkSize;
    const chunk = await source.read(start, Math.min(chunkSize, source.size - start));
    cache.set(index, chunk);
    if (cache.size > maxCachedChunks) {
      const oldest = cache.keys().next();
      if (!oldest.done) {
        cache.delete(oldest.value);
      }
    }

    return chunk;
  }

  return {
    size: source.size,

    async read(offset: number, length: number): Promise<Uint8Array> {
      const start = clamp(offset, 0, source.size);
      const end = clamp(offset + length, start, source.size);
      if (end === start) {
        return new Uint8Array(0);
      }

      const firstChunk = Math.floor(start / chunkSize);
      const lastChunk = Math.floor((end - 1) / chunkSize);

      if (firstChunk === lastChunk) {
        const chunk = await chunkAt(firstChunk);
        const within = start - firstChunk * chunkSize;

        // The underlying source may have returned less than a whole chunk;
        // `subarray` clamps to what is there rather than inventing zeroes.
        return chunk.subarray(within, Math.min(end - firstChunk * chunkSize, chunk.length));
      }

      const result = new Uint8Array(end - start);
      let written = 0;
      for (let index = firstChunk; index <= lastChunk; index++) {
        const chunk = await chunkAt(index);
        const chunkStart = index * chunkSize;
        const from = Math.max(start, chunkStart) - chunkStart;
        const to = Math.min(end, chunkStart + chunkSize) - chunkStart;
        const slice = chunk.subarray(from, Math.min(to, chunk.length));
        result.set(slice, written);
        written += slice.length;
        if (slice.length < to - from) {
          // The source ended early; there is nothing after this.
          break;
        }
      }

      return written === result.length ? result : result.subarray(0, written);
    },
  };
}

/** A source over bytes already in memory. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,

    read(offset: number, length: number): Promise<Uint8Array> {
      const start = clamp(offset, 0, bytes.length);
      const end = clamp(offset + length, start, bytes.length);

      return Promise.resolve(bytes.subarray(start, end));
    },
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
