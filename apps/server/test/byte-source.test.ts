import { describe, expect, it } from "vitest";
import {
  type ByteSource,
  bytesSource,
  chunkedSource,
  DEFAULT_CACHED_CHUNKS,
  DEFAULT_CHUNK_SIZE,
  r2Source,
} from "../src/library/byte-source";
import { extractMetadata } from "../src/library/metadata";
import { fixtureBytes, fixtureTrack } from "./fixtures/files";
import { recordingSource, seedFixtureObject, testEnv } from "./support";

/** Bytes whose value says where they are, so a wrong offset cannot pass. */
function ramp(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => index % 251);
}

describe("bytesSource", () => {
  const bytes = ramp(100);

  it("reports the length of what it holds", () => {
    expect(bytesSource(bytes).size).toBe(100);
  });

  it("reads the range asked for", async () => {
    await expect(bytesSource(bytes).read(10, 5)).resolves.toEqual(bytes.subarray(10, 15));
  });

  it("stops at the end rather than padding", async () => {
    await expect(bytesSource(bytes).read(95, 20)).resolves.toEqual(bytes.subarray(95));
  });

  it("answers a read past the end with nothing", async () => {
    await expect(bytesSource(bytes).read(200, 10)).resolves.toEqual(new Uint8Array(0));
  });
});

describe("chunkedSource", () => {
  const bytes = ramp(1000);

  function chunked(chunkSize: number, maxCachedChunks?: number) {
    const source = recordingSource(bytes);

    return { source, chunked: chunkedSource(source, { chunkSize, maxCachedChunks }) };
  }

  it("keeps the underlying size", () => {
    expect(chunked(64).chunked.size).toBe(1000);
  });

  it("reads a whole chunk to answer one byte", async () => {
    const { source, chunked: reader } = chunked(64);

    await expect(reader.read(70, 1)).resolves.toEqual(bytes.subarray(70, 71));
    expect(source.ranges).toEqual([{ start: 64, end: 128 }]);
  });

  it("serves a second read inside the same chunk from memory", async () => {
    const { source, chunked: reader } = chunked(64);

    await reader.read(0, 4);
    await reader.read(8, 4);
    await reader.read(60, 4);

    expect(source.readCount).toBe(1);
  });

  it("coalesces a walk of small reads into one read per chunk", async () => {
    const { source, chunked: reader } = chunked(256);

    for (let offset = 0; offset < 512; offset += 4) {
      await reader.read(offset, 4);
    }

    expect(source.readCount).toBe(2);
  });

  it("joins a read that straddles a chunk boundary", async () => {
    const { source, chunked: reader } = chunked(64);

    await expect(reader.read(60, 10)).resolves.toEqual(bytes.subarray(60, 70));
    expect(source.ranges).toEqual([
      { start: 0, end: 64 },
      { start: 64, end: 128 },
    ]);
  });

  it("joins a read spanning several whole chunks", async () => {
    const { chunked: reader } = chunked(16);

    await expect(reader.read(5, 100)).resolves.toEqual(bytes.subarray(5, 105));
  });

  it("reads a range that begins exactly on a boundary", async () => {
    const { source, chunked: reader } = chunked(64);

    await expect(reader.read(64, 64)).resolves.toEqual(bytes.subarray(64, 128));
    expect(source.ranges).toEqual([{ start: 64, end: 128 }]);
  });

  it("reads a range that ends exactly on a boundary", async () => {
    const { source, chunked: reader } = chunked(64);

    await expect(reader.read(0, 64)).resolves.toEqual(bytes.subarray(0, 64));
    expect(source.readCount).toBe(1);
  });

  it("does not read past the end of the object", async () => {
    const { source, chunked: reader } = chunked(64);

    await reader.read(990, 64);

    expect(source.ranges).toEqual([{ start: 960, end: 1000 }]);
  });

  it("truncates a read that runs past the end", async () => {
    const { chunked: reader } = chunked(64);

    await expect(reader.read(990, 100)).resolves.toEqual(bytes.subarray(990));
  });

  it("truncates a straddling read that runs past the end", async () => {
    const { chunked: reader } = chunked(64);

    await expect(reader.read(950, 100)).resolves.toEqual(bytes.subarray(950));
  });

  it("answers a read starting past the end with nothing, reading nothing", async () => {
    const { source, chunked: reader } = chunked(64);

    await expect(reader.read(1000, 10)).resolves.toEqual(new Uint8Array(0));
    expect(source.readCount).toBe(0);
  });

  it("answers a zero-length read without reading", async () => {
    const { source, chunked: reader } = chunked(64);

    await expect(reader.read(10, 0)).resolves.toEqual(new Uint8Array(0));
    expect(source.readCount).toBe(0);
  });

  it("clamps a negative offset to the start", async () => {
    const { chunked: reader } = chunked(64);

    await expect(reader.read(-10, 12)).resolves.toEqual(bytes.subarray(0, 2));
  });

  it("re-reads a chunk it has dropped", async () => {
    const { source, chunked: reader } = chunked(64, 1);

    await reader.read(0, 4);
    await reader.read(64, 4);
    await reader.read(0, 4);

    expect(source.ranges).toHaveLength(3);
  });

  it("keeps the chunk it used most recently", async () => {
    const { source, chunked: reader } = chunked(64, 2);

    await reader.read(0, 4);
    await reader.read(64, 4);
    // Touching chunk 0 again makes chunk 1 the least recent, so reading a
    // third chunk drops chunk 1 and leaves chunk 0 in memory.
    await reader.read(0, 4);
    await reader.read(128, 4);
    await reader.read(0, 4);

    expect(source.readCount).toBe(3);
  });

  it("refuses a chunk size that is not a positive whole number", () => {
    const source: ByteSource = bytesSource(bytes);

    expect(() => chunkedSource(source, { chunkSize: 0 })).toThrow(RangeError);
    expect(() => chunkedSource(source, { chunkSize: -1 })).toThrow(RangeError);
    expect(() => chunkedSource(source, { chunkSize: 1.5 })).toThrow(RangeError);
  });

  it("refuses a cache that holds nothing", () => {
    expect(() => chunkedSource(bytesSource(bytes), { maxCachedChunks: 0 })).toThrow(RangeError);
  });

  it("reads one chunk per object when the defaults are left alone", async () => {
    const source = recordingSource(bytes);
    const reader = chunkedSource(source);

    await reader.read(0, 10);
    await reader.read(500, 10);
    await reader.read(990, 10);

    expect(DEFAULT_CHUNK_SIZE).toBeGreaterThan(bytes.length);
    expect(DEFAULT_CACHED_CHUNKS).toBeGreaterThan(1);
    expect(source.ranges).toEqual([{ start: 0, end: 1000 }]);
  });
});

describe("recordingSource", () => {
  const bytes = ramp(100);

  it("counts the reads and the bytes they took", async () => {
    const source = recordingSource(bytes);

    await source.read(0, 10);
    await source.read(90, 20);

    expect(source.readCount).toBe(2);
    expect(source.bytesRead).toBe(20);
  });

  it("knows which offsets were touched", async () => {
    const source = recordingSource(bytes);

    await source.read(10, 10);

    expect(source.readAt(10)).toBe(true);
    expect(source.readAt(19)).toBe(true);
    expect(source.readAt(20)).toBe(false);
    expect(source.neverRead(20, 100)).toBe(true);
    expect(source.neverRead(0, 11)).toBe(false);
  });
});

describe("r2Source", () => {
  it("reads a range of an object in the bucket", async () => {
    const track = fixtureTrack("silent-track.mp3");
    const stored = await seedFixtureObject(track.file);
    const source = r2Source(testEnv.MUSIC, stored.key, stored.size);

    expect(source.size).toBe(track.size);
    await expect(source.read(10, 20)).resolves.toEqual(fixtureBytes(track.file).subarray(10, 30));
  });

  it("stops at the end of the object rather than asking R2 for more", async () => {
    const track = fixtureTrack("hushed-interlude.flac");
    const stored = await seedFixtureObject(track.file);
    const source = r2Source(testEnv.MUSIC, stored.key, stored.size);

    // R2 refuses a range that begins past the end, so the clamping is not a
    // convenience: a parser reading the last bytes of a file would throw.
    await expect(source.read(stored.size - 8, 64)).resolves.toEqual(
      fixtureBytes(track.file).subarray(stored.size - 8),
    );
    await expect(source.read(stored.size, 64)).resolves.toEqual(new Uint8Array(0));
  });

  it("says so when the object has gone", async () => {
    const stored = await seedFixtureObject("untagged.mp3");
    await testEnv.MUSIC.delete(stored.key);

    await expect(r2Source(testEnv.MUSIC, stored.key, stored.size).read(0, 16)).rejects.toThrow(
      stored.key,
    );
  });

  it("describes a track read straight out of the bucket", async () => {
    const track = fixtureTrack("tail-loaded.m4a");
    const stored = await seedFixtureObject(track.file);

    const metadata = await extractMetadata(
      r2Source(testEnv.MUSIC, stored.key, stored.size),
      track.suffix,
    );

    expect(metadata.title).toBe(track.tags?.title);
    expect(metadata.duration).toBeCloseTo(track.duration.seconds, 3);
  });
});
