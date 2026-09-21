import { describe, expect, it } from "vitest";
import { bytesSource, DEFAULT_CHUNK_SIZE } from "../src/library/byte-source";
import { extractMetadata, MetadataError, type TrackMetadata } from "../src/library/metadata";
import { type FixtureTrack, fixtureBytes, fixtures, fixtureTrack } from "./fixtures/files";
import { recordingSource } from "./support";

/**
 * What a track's own bytes say, read the way the scan will read them.
 *
 * Every expectation here comes from `manifest.json`, which the generator
 * writes: the tags each fixture carries, the duration and which of the three
 * rules yields it, the bit rate, and the cover. Nothing is restated.
 *
 * A chunk of 256 bytes is used wherever a test looks at *which* parts of a
 * file were read. The fixtures are a few kilobytes, so the default chunk would
 * swallow each of them whole and prove nothing; 256 bytes keeps the same ratio
 * of chunk to header that a real track has to a 256 KiB one. The tests that
 * count reads on a track of a realistic size grow a fixture first and leave
 * the chunk size alone.
 */
const SMALL_CHUNK = 256;

/** Around 4 MiB: a track of the size the scan will actually meet. */
const REALISTIC_SIZE = 4 * 1024 * 1024;

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

  it("is the first picture, not the one that calls itself the front cover", async () => {
    // Every fixture carries exactly one picture, so the rule #9 states - the
    // first picture an album's track carries - is untested by them. This
    // FLAC carries two: an "other" picture first, and the fixture's own
    // front cover behind it.
    const other = Uint8Array.of(0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0x02, 0x03);
    const { cover } = await extractMetadata(
      bytesSource(flacWithLeadingPicture(other, "image/jpeg")),
      "flac",
    );

    expect(cover?.mimeType).toBe("image/jpeg");
    expect(cover?.bytes).toEqual(other);
  });
});

/* -------------------------------------------------------- duration -- */

/**
 * The duration each format states in its own header, read here so the
 * extractor's answer can be held against the rule the manifest names rather
 * than against a number copied from it.
 */
const DURATION_RULES: Record<FixtureTrack["duration"]["source"], (track: FixtureTrack) => number> =
  {
    "cbr-estimate": (track) => {
      const bytes = fixtureBytes(track.file);
      const audioBytes = bytes.length - id3TagLength(bytes);

      return (audioBytes * 8) / (track.bitRate.kbps * 1000);
    },

    streaminfo: (track) => {
      // STREAMINFO packs the sample rate and the total sample count into the
      // 64 bits that begin ten bytes into the block.
      const block = flacStreamInfo(fixtureBytes(track.file));
      const packed = new DataView(block.buffer, block.byteOffset, block.byteLength).getBigUint64(
        10,
      );

      return Number(packed & 0xf_ffff_ffffn) / Number(packed >> 44n);
    },

    mvhd: (track) => {
      // Version 0 `mvhd`: version and flags, created and modified, then the
      // timescale and the duration counted in it.
      const mvhd = childAtom(childAtom(fixtureBytes(track.file), "moov"), "mvhd");
      const view = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength);

      return view.getUint32(16) / view.getUint32(12);
    },
  };

describe.each(fixtures.tracks.map((track) => [track.file, track.duration.source, track] as const))(
  "the duration of %s",
  (_file, source, track) => {
    it(`is the one its own ${source} yields`, async () => {
      const fromTheHeader = DURATION_RULES[source](track);

      // Both numbers come from the header; they agree to the millisecond,
      // which no measurement of a decoded stream would.
      expect((await extract(track)).duration).toBeCloseTo(fromTheHeader, 3);
    });
  },
);

describe("a duration that is derived and not measured", () => {
  it("grows with an MP3's size, because the estimate is over its bytes", async () => {
    const single = fixtureBytes("silent-track.mp3");
    const audioBytes = single.length - id3TagLength(single);
    const grown = grownMp3(REALISTIC_SIZE);
    const times = (grown.length - id3TagLength(grown)) / audioBytes;

    expect(times).toBeGreaterThan(1000);
    expect((await extractMetadata(bytesSource(grown), "mp3")).duration).toBeCloseTo(
      fixtureTrack("silent-track.mp3").duration.seconds * times,
      1,
    );
  });

  it("does not move when a FLAC grows, because STREAMINFO states it", async () => {
    const grown = grownFlac(REALISTIC_SIZE);

    expect((await extractMetadata(bytesSource(grown), "flac")).duration).toBe(
      fixtureTrack("hushed-interlude.flac").duration.seconds,
    );
  });

  it.each(["front-loaded.m4a", "tail-loaded.m4a"])(
    "does not move when %s grows, because mvhd states it",
    async (file) => {
      const grown = grownM4a(file, REALISTIC_SIZE);

      expect((await extractMetadata(bytesSource(grown), "m4a")).duration).toBeCloseTo(
        fixtureTrack(file).duration.seconds,
        3,
      );
    },
  );
});

/* ---------------------------------------------------- bounded reads -- */

describe("what extraction reads", () => {
  it("reads the tail-loaded M4A's head and tail, and nothing in between", async () => {
    const track = fixtureTrack("tail-loaded.m4a");
    const bytes = fixtureBytes(track.file);
    const source = recordingSource(bytes);

    const metadata = await extractMetadata(source, track.suffix, { chunkSize: SMALL_CHUNK });

    // Fully tagged, from a file whose `moov` is behind its `mdat`.
    expect(metadata.title).toBe(track.tags?.title);
    expect(metadata.cover?.mimeType).toBe("image/png");

    const moovAt = topLevelAtomOffset(bytes, "moov");
    const mdatAt = topLevelAtomOffset(bytes, "mdat");
    expect(mdatAt).toBeLessThan(moovAt);

    // The head, where the file type is, and the tail, where the movie box is.
    expect(source.readAt(0)).toBe(true);
    expect(source.readAt(moovAt)).toBe(true);

    // The `mdat` body between them is never asked for. It begins after the
    // atom's own eight-byte header and ends where `moov` begins.
    expect(source.neverRead(mdatAt + SMALL_CHUNK, moovAt - (moovAt % SMALL_CHUNK))).toBe(true);
  });

  it("reads the front-loaded M4A's head only", async () => {
    const track = fixtureTrack("front-loaded.m4a");
    const bytes = fixtureBytes(track.file);
    const source = recordingSource(bytes);

    await extractMetadata(source, track.suffix, { chunkSize: SMALL_CHUNK });

    // Everything but the tail scan for an appended tag sits in the head, so
    // the `mdat` body between the two is never asked for. The tail scan looks
    // for an ID3v1 tag in the last 128 bytes, and so touches the chunk those
    // begin in.
    const mdatBodyAt = topLevelAtomOffset(bytes, "mdat") + 8;
    const tailScanAt = Math.floor((bytes.length - 128) / SMALL_CHUNK) * SMALL_CHUNK;

    expect(source.readAt(0)).toBe(true);
    expect(source.neverRead(Math.ceil(mdatBodyAt / SMALL_CHUNK) * SMALL_CHUNK, tailScanAt)).toBe(
      true,
    );
  });

  const realistic: Record<string, () => Uint8Array> = {
    "silent-track.mp3": () => grownMp3(REALISTIC_SIZE),
    "hushed-interlude.flac": () => grownFlac(REALISTIC_SIZE),
    "front-loaded.m4a": () => grownM4a("front-loaded.m4a", REALISTIC_SIZE),
    "tail-loaded.m4a": () => grownM4a("tail-loaded.m4a", REALISTIC_SIZE),
  };

  it.each(Object.keys(realistic))(
    "costs a handful of range reads on a %s of a realistic size",
    async (file) => {
      const track = fixtureTrack(file);
      const grown = (realistic[file] as () => Uint8Array)();
      const source = recordingSource(grown);

      const metadata = await extractMetadata(source, track.suffix);

      expect(grown.length).toBeGreaterThan(REALISTIC_SIZE);
      expect(metadata.title).toBe(track.tags?.title);

      // Each read is one Cloudflare subrequest, and a scheduled run has a
      // budget of them: a track must cost a few, not one per header field.
      expect(source.readCount).toBeLessThanOrEqual(4);

      // And a fraction of the object, never the object.
      expect(source.bytesRead).toBeLessThanOrEqual(4 * DEFAULT_CHUNK_SIZE);
      expect(source.bytesRead).toBeLessThan(grown.length / 2);
    },
  );
});

/* ---------------------------------------------------------- failures -- */

describe("what extraction refuses", () => {
  const garbage = Uint8Array.from({ length: 5000 }, (_, index) => (index * 37) % 256);

  it.each(["ogg", "wav", "m3u", "", "MP3", "mp3.", "toString"])(
    "refuses the suffix %s as unsupported",
    async (suffix) => {
      await expect(extractMetadata(bytesSource(garbage), suffix)).rejects.toMatchObject({
        name: "MetadataError",
        code: "unsupported-format",
      });
    },
  );

  it.each(["mp3", "m4a", "flac"])("refuses garbage named .%s", async (suffix) => {
    await expect(extractMetadata(bytesSource(garbage), suffix)).rejects.toMatchObject({
      name: "MetadataError",
      code: "unreadable",
    });
  });

  it.each(fixtures.tracks.map((track) => [track.file, track] as const))(
    "refuses the first eight bytes of %s",
    async (_file, track) => {
      const head = fixtureBytes(track.file).slice(0, 8);

      await expect(extractMetadata(bytesSource(head), track.suffix)).rejects.toMatchObject({
        name: "MetadataError",
        code: "unreadable",
      });
    },
  );

  it("refuses an M4A cut in half, whose movie box went with the missing half", async () => {
    const bytes = fixtureBytes("tail-loaded.m4a");

    await expect(
      extractMetadata(bytesSource(bytes.slice(0, bytes.length / 2)), "m4a"),
    ).rejects.toMatchObject({ name: "MetadataError", code: "unreadable" });
  });

  it("refuses an empty object", async () => {
    await expect(extractMetadata(bytesSource(new Uint8Array(0)), "mp3")).rejects.toMatchObject({
      name: "MetadataError",
      code: "unreadable",
    });
  });

  it("still reads an MP3 cut in half, because its tags and header survived", async () => {
    const bytes = fixtureBytes("silent-track.mp3");
    const metadata = await extractMetadata(bytesSource(bytes.slice(0, bytes.length / 2)), "mp3");

    expect(metadata.title).toBe(fixtureTrack("silent-track.mp3").tags?.title);
    expect(metadata.duration).toBeGreaterThan(0);
  });

  it("blames the source, not the bytes, when a read fails", async () => {
    const track = fixtureTrack("silent-track.mp3");
    const outage = new Error("R2 said 500");
    const failing = {
      size: track.size,
      read: () => Promise.reject(outage),
    };

    const error = await extractMetadata(failing, "mp3").catch((thrown: unknown) => thrown);

    // A bucket that is briefly unavailable must not look like a corrupt
    // file: the scan would write the track off and never look again.
    expect(error).toBeInstanceOf(MetadataError);
    expect((error as MetadataError).code).toBe("source-failed");
    expect((error as MetadataError).cause).toBe(outage);
  });

  it("blames the source when it fails partway through a parse", async () => {
    const track = fixtureTrack("tail-loaded.m4a");
    const bytes = fixtureBytes(track.file);
    const vanished = new Error("the object was deleted mid-scan");
    let reads = 0;
    const flaky = {
      size: bytes.length,
      read: (offset: number, length: number) => {
        reads += 1;

        return reads > 1
          ? Promise.reject(vanished)
          : Promise.resolve(bytes.subarray(offset, Math.min(offset + length, bytes.length)));
      },
    };

    const error = await extractMetadata(flaky, "m4a", { chunkSize: SMALL_CHUNK }).catch(
      (thrown: unknown) => thrown,
    );

    expect(reads).toBeGreaterThan(1);
    expect((error as MetadataError).code).toBe("source-failed");
    expect((error as MetadataError).cause).toBe(vanished);
  });

  it("carries what went wrong as the cause", async () => {
    const error = await extractMetadata(bytesSource(garbage), "flac").catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(MetadataError);
    expect((error as MetadataError).cause).toBeInstanceOf(Error);
  });
});

/* ----------------------------------------------------------- growing -- */

/** How many bytes an ID3v2 tag occupies, header included, or 0 for none. */
function id3TagLength(bytes: Uint8Array): number {
  if (String.fromCharCode(...bytes.slice(0, 3)) !== "ID3") {
    return 0;
  }

  // The size is four seven-bit groups, so a byte of it can never look like a
  // sync word.
  return (
    10 +
    (((bytes[6] as number) << 21) |
      ((bytes[7] as number) << 14) |
      ((bytes[8] as number) << 7) |
      (bytes[9] as number))
  );
}

/**
 * The tagged MP3 with its frames repeated until it is at least this long.
 *
 * An MP3 of a realistic size is this fixture's tag followed by thousands more
 * of the same frames, which is exactly what a scan meets and what makes the
 * difference between reading a header and reading a track visible.
 */
function grownMp3(minimumSize: number): Uint8Array {
  const bytes = fixtureBytes("silent-track.mp3");
  const tagLength = id3TagLength(bytes);
  const frames = bytes.subarray(tagLength);
  const repeats = Math.ceil((minimumSize - tagLength) / frames.length);
  const grown = new Uint8Array(tagLength + frames.length * repeats);

  grown.set(bytes.subarray(0, tagLength));
  for (let repeat = 0; repeat < repeats; repeat++) {
    grown.set(frames, tagLength + repeat * frames.length);
  }

  return grown;
}

/**
 * The FLAC with its audio padded out. STREAMINFO still states the duration,
 * so a parser that answers with anything else has measured the stream.
 */
function grownFlac(minimumSize: number): Uint8Array {
  const bytes = fixtureBytes("hushed-interlude.flac");
  const grown = new Uint8Array(Math.max(minimumSize + 1, bytes.length));
  grown.set(bytes);

  return grown;
}

/** One M4A with its `mdat` padded out, and every following atom pushed back. */
function grownM4a(file: string, minimumSize: number): Uint8Array {
  const bytes = fixtureBytes(file);
  const mdatAt = topLevelAtomOffset(bytes, "mdat");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mdatSize = view.getUint32(mdatAt);
  const padding = minimumSize + 1 - bytes.length;

  const grown = new Uint8Array(bytes.length + padding);
  grown.set(bytes.subarray(0, mdatAt + mdatSize));
  grown.set(bytes.subarray(mdatAt + mdatSize), mdatAt + mdatSize + padding);
  new DataView(grown.buffer).setUint32(mdatAt, mdatSize + padding);

  return grown;
}

/** Where a top-level atom of this type begins, counted from the file's start. */
function topLevelAtomOffset(bytes: Uint8Array, type: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset);
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === type) {
      return offset;
    }
    if (size < 8) {
      break;
    }
    offset += size;
  }

  throw new Error(`no top-level ${type} atom`);
}

/** The body of the one child atom of this type inside these bytes. */
function childAtom(bytes: Uint8Array, type: string): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset);
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === type) {
      return bytes.subarray(offset + 8, offset + size);
    }
    if (size < 8) {
      break;
    }
    offset += size;
  }

  throw new Error(`no ${type} atom`);
}

/**
 * The FLAC fixture with one more PICTURE block in front of the one it has.
 *
 * A FLAC metadata block is a byte of "is this the last one" and type, a
 * 24-bit length, and the body; a PICTURE body is the picture type, then the
 * MIME string and the description each behind their length, then four
 * dimensions, then the image behind its own length.
 */
function flacWithLeadingPicture(image: Uint8Array, mimeType: string): Uint8Array {
  const bytes = fixtureBytes("hushed-interlude.flac");
  const mime = Uint8Array.from(mimeType, (character) => character.charCodeAt(0));
  const body = new Uint8Array(4 + 4 + mime.length + 4 + 16 + 4 + image.length);
  const view = new DataView(body.buffer);

  // Picture type 0, "Other": whatever a file calls its front cover, the
  // first picture is the one an album takes.
  view.setUint32(0, 0);
  view.setUint32(4, mime.length);
  body.set(mime, 8);
  view.setUint32(8 + mime.length, 0);
  view.setUint32(8 + mime.length + 4 + 16, image.length);
  body.set(image, 8 + mime.length + 4 + 16 + 4);

  const block = new Uint8Array(4 + body.length);
  block[0] = 6;
  block[1] = (body.length >> 16) & 0xff;
  block[2] = (body.length >> 8) & 0xff;
  block[3] = body.length & 0xff;
  block.set(body, 4);

  // In front of the block that is there, which stays the last one.
  const at = flacPictureBlockOffset(bytes);
  const grown = new Uint8Array(bytes.length + block.length);
  grown.set(bytes.subarray(0, at));
  grown.set(block, at);
  grown.set(bytes.subarray(at), at + block.length);

  return grown;
}

/** Where the FLAC fixture's PICTURE block header begins. */
function flacPictureBlockOffset(bytes: Uint8Array): number {
  let offset = 4;
  while (offset + 4 <= bytes.length) {
    const type = (bytes[offset] as number) & 0x7f;
    if (type === 6) {
      return offset;
    }

    const length =
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number);
    if ((bytes[offset] as number) & 0x80) {
      break;
    }
    offset += 4 + length;
  }

  throw new Error("the FLAC fixture has no PICTURE block");
}

/** The STREAMINFO block of a FLAC file, which is always the first one. */
function flacStreamInfo(bytes: Uint8Array): Uint8Array {
  const length = ((bytes[5] as number) << 16) | ((bytes[6] as number) << 8) | (bytes[7] as number);

  return bytes.subarray(8, 8 + length);
}
