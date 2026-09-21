import { describe, expect, it } from "vitest";
import { buildFixtures } from "./fixtures/build";
import { fixtureBytes, fixturePlaylistText, fixtures, fixtureTrack } from "./fixtures/files";

/**
 * The committed fixtures: that they are what the manifest says, that they parse
 * as the containers they claim to be, and that the generator still produces
 * them byte for byte.
 *
 * The container walks below are deliberately hand-written and shallow. They are
 * not the metadata extractor - that is #11's job - only enough to prove these
 * bytes are a real ID3 tag, a real FLAC block chain and a real MP4 atom tree,
 * so a failing extractor test later means the extractor is wrong.
 */

const KILOBYTE = 1024;

describe("the fixture manifest", () => {
  it("describes exactly the files that are committed", () => {
    const named = [...fixtures.tracks.map((track) => track.file), fixtures.playlist.file];

    expect(named).toEqual([
      "silent-track.mp3",
      "hushed-interlude.flac",
      "front-loaded.m4a",
      "tail-loaded.m4a",
      "favourites.m3u",
    ]);
  });

  it("records each file's real size, and each file stays small", () => {
    for (const { file, size } of [...fixtures.tracks, fixtures.playlist]) {
      const bytes = fixtureBytes(file);

      expect(bytes.length, file).toBe(size);
      expect(bytes.length, file).toBeLessThan(8 * KILOBYTE);
    }
  });

  it("gives every track a distinct R2 key under an artist and album directory", () => {
    const keys = fixtures.tracks.map((track) => track.r2Key);

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key.split("/")).toHaveLength(3);
    }
  });
});

describe("the generator", () => {
  const built = buildFixtures();

  it("still produces the committed files byte for byte", () => {
    // `build.ts` is what the generator script writes out, so this is the
    // reproducibility claim: anyone can regenerate the fixtures and get these
    // same bytes, with nothing installed.
    expect(built.files.map((file) => file.name).sort()).toEqual(
      [...fixtures.tracks.map((track) => track.file), fixtures.playlist.file].sort(),
    );

    for (const file of built.files) {
      expect([...file.bytes], file.name).toEqual([...fixtureBytes(file.name)]);
    }
  });

  it("still produces the committed manifest", () => {
    expect(built.manifest).toEqual(fixtures);
  });
});

describe("the MP3 fixture", () => {
  const track = fixtures.tracks[0];
  const bytes = fixtureBytes("silent-track.mp3");

  it("opens with an ID3v2.3 tag", () => {
    expect(String.fromCharCode(...bytes.slice(0, 3))).toBe("ID3");
    expect([bytes[3], bytes[4]]).toEqual([3, 0]);
  });

  it("carries the tagged text the manifest promises, and a front cover", () => {
    const { frames, audioAt } = readId3(bytes);

    expect(frames.get("TIT2")).toBe(track?.tags.title);
    expect(frames.get("TPE1")).toBe(track?.tags.artist);
    expect(frames.get("TPE2")).toBe(track?.tags.albumArtist);
    expect(frames.get("TALB")).toBe(track?.tags.album);
    expect(frames.get("TRCK")).toBe("1/2");
    expect(frames.get("TPOS")).toBe("1/1");
    expect(frames.get("TYER")).toBe("2001");
    expect(frames.get("TCON")).toBe(track?.tags.genre);
    expect(frames.has("APIC")).toBe(true);
    expect(audioAt).toBeLessThan(bytes.length);
  });

  it("embeds the cover as the PNG the manifest describes", () => {
    const start = indexOfPngSignature(bytes);

    expect(start).toBeGreaterThan(0);
    expect(bytes.length - start).toBeGreaterThanOrEqual(track?.cover?.size ?? 0);
    expect(track?.cover?.mimeType).toBe("image/png");
  });

  it("continues with MPEG frames whose header says 128 kbps at 44.1 kHz", () => {
    const { audioAt } = readId3(bytes);
    const header = bytes.slice(audioAt, audioAt + 4);

    expect(header[0]).toBe(0xff);
    // Sync, MPEG-1, Layer III, no CRC.
    expect(header[1]).toBe(0xfb);
    // Bit rate index 9 (128 kbps) and sample rate index 0 (44.1 kHz).
    expect((header[2] as number) >> 4).toBe(9);
    expect(((header[2] as number) >> 2) & 0b11).toBe(0);
  });
});

describe("the FLAC fixture", () => {
  const track = fixtures.tracks[1];
  const bytes = fixtureBytes("hushed-interlude.flac");

  it("opens with the fLaC marker", () => {
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("fLaC");
  });

  it("carries a STREAMINFO, a VORBIS_COMMENT and a PICTURE block, in that order", () => {
    const blocks = readFlacBlocks(bytes);

    expect(blocks.map((block) => block.type)).toEqual([0, 4, 6]);
    expect(blocks.at(-1)?.last).toBe(true);
  });

  it("states the duration the manifest expects in STREAMINFO", () => {
    const streamInfo = blockOfType(bytes, 0);
    const view = new DataView(streamInfo.buffer, streamInfo.byteOffset, streamInfo.byteLength);
    const packed = view.getBigUint64(10);
    const sampleRate = Number(packed >> 44n);
    const totalSamples = Number(packed & 0xf_ffff_ffffn);

    expect(sampleRate).toBe(44_100);
    expect(totalSamples / sampleRate).toBeCloseTo(track?.duration.seconds ?? 0, 3);
  });

  it("names the tags in its comment block", () => {
    const comments = readVorbisComments(blockOfType(bytes, 4));

    expect(comments.get("TITLE")).toBe(track?.tags.title);
    expect(comments.get("ARTIST")).toBe(track?.tags.artist);
    expect(comments.get("ALBUMARTIST")).toBe(track?.tags.albumArtist);
    expect(comments.get("ALBUM")).toBe(track?.tags.album);
    expect(comments.get("TRACKNUMBER")).toBe("2");
    expect(comments.get("DATE")).toBe("2001");
    expect(comments.get("GENRE")).toBe(track?.tags.genre);
  });

  it("holds the cover in its PICTURE block", () => {
    const picture = blockOfType(bytes, 6);
    const view = new DataView(picture.buffer, picture.byteOffset, picture.byteLength);
    const mimeLength = view.getUint32(4);
    const mimeType = String.fromCharCode(...picture.slice(8, 8 + mimeLength));

    // Picture type 3 is the front cover.
    expect(view.getUint32(0)).toBe(3);
    expect(mimeType).toBe(track?.cover?.mimeType);
    expect(indexOfPngSignature(picture)).toBeGreaterThan(0);
  });
});

describe("the M4A fixtures", () => {
  it.each([
    ["front-loaded.m4a", true],
    ["tail-loaded.m4a", false],
  ])("walks %s as a complete atom tree", (file, moovFirst) => {
    const bytes = fixtureBytes(file);
    const atoms = readAtoms(bytes);

    // Every atom's size accounts for the whole file: nothing is left over.
    expect(atoms.reduce((total, atom) => total + atom.size, 0)).toBe(bytes.length);
    expect(atoms.map((atom) => atom.type)).toEqual(
      moovFirst ? ["ftyp", "moov", "mdat"] : ["ftyp", "mdat", "moov"],
    );
  });

  it.each([
    ["front-loaded.m4a", true],
    ["tail-loaded.m4a", false],
  ])("puts moov %s mdat in %s", (file, moovFirst) => {
    const atoms = readAtoms(fixtureBytes(file));
    const offsetOf = (type: string) =>
      atoms.find((atom) => atom.type === type)?.offset ?? Number.NaN;

    expect(offsetOf("moov")).toBeGreaterThan(0);
    expect(offsetOf("mdat")).toBeGreaterThan(0);
    expect(offsetOf("moov") < offsetOf("mdat")).toBe(moovFirst);
  });

  it.each(["front-loaded.m4a", "tail-loaded.m4a"])(
    "states %s's duration in mvhd, as the manifest says",
    (file) => {
      const mvhd = atomBody(atomBody(fixtureBytes(file), "moov"), "mvhd");
      const view = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength);
      const expected = fixtureTrack(file);

      // Version 0: version and flags, created and modified, then the timescale
      // and the duration counted in it.
      expect(view.getUint32(16) / view.getUint32(12)).toBeCloseTo(expected.duration.seconds, 3);
    },
  );

  it.each(["front-loaded.m4a", "tail-loaded.m4a"])("tags %s in an ilst", (file) => {
    const expected = fixtureTrack(file);
    const moov = atomBody(fixtureBytes(file), "moov");
    const meta = atomBody(atomBody(moov, "udta"), "meta");
    // `meta` is a full box: four bytes of version and flags come first.
    const items = readAtoms(atomBody(meta.slice(4), "ilst"));
    const text = (name: string) => {
      const item = items.find((candidate) => candidate.type === name);
      const data = atomBody(item?.body ?? new Uint8Array(0), "data");

      // The data atom opens with its type and locale, then the value.
      return new TextDecoder().decode(data.slice(8));
    };

    expect(items.map((item) => item.type)).toEqual([
      "\u00a9nam",
      "\u00a9ART",
      "aART",
      "\u00a9alb",
      "\u00a9day",
      "\u00a9gen",
      "trkn",
      "disk",
      "covr",
    ]);
    expect(text("\u00a9nam")).toBe(expected.tags.title);
    expect(text("aART")).toBe(expected.tags.albumArtist);
    expect(text("\u00a9alb")).toBe(expected.tags.album);
    expect(text("\u00a9day")).toBe(String(expected.tags.year));
    expect(indexOfPngSignature(atomBody(items.at(-1)?.body ?? new Uint8Array(0), "data"))).toBe(8);
  });
});

describe("the m3u fixture", () => {
  it("is the lines the manifest lists, newline-separated", () => {
    expect(fixturePlaylistText.split("\n").slice(0, -1)).toEqual(
      fixtures.playlist.lines.map((line) => line.text),
    );
  });

  it("names three tracks that exist, one that does not, and one relative path", () => {
    const { lines, trackKeys, unmatchedLineCount } = fixtures.playlist;
    const paths = lines.filter((line) => line.resolvesTo !== null);
    const known = new Set(fixtures.tracks.map((track) => track.r2Key));

    expect(trackKeys).toHaveLength(3);
    expect(trackKeys.every((key) => known.has(key))).toBe(true);
    expect(paths.filter((line) => !line.matchesATrack)).toHaveLength(unmatchedLineCount);
    expect(paths.some((line) => line.text.startsWith("../"))).toBe(true);
    expect(paths.some((line) => line.text.startsWith("/"))).toBe(true);
  });

  it("leaves one fixture track out, so an import cannot pass by taking everything", () => {
    const listed = new Set(fixtures.playlist.trackKeys);

    expect(fixtures.tracks.filter((track) => !listed.has(track.r2Key))).toHaveLength(1);
  });
});

/* ------------------------------------------------- container walkers -- */

/** The text frames of an ID3v2.3 tag, and where the audio starts after it. */
function readId3(bytes: Uint8Array): { frames: Map<string, string>; audioAt: number } {
  const size =
    ((bytes[6] as number) << 21) |
    ((bytes[7] as number) << 14) |
    ((bytes[8] as number) << 7) |
    (bytes[9] as number);
  const end = 10 + size;
  const frames = new Map<string, string>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 10;
  while (offset + 10 <= end) {
    const id = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const frameSize = view.getUint32(offset + 4);
    if (frameSize === 0) break;

    const body = bytes.slice(offset + 10, offset + 10 + frameSize);
    // Encoding byte 0 is ISO-8859-1, which is what the fixture writes.
    frames.set(id, id.startsWith("T") ? String.fromCharCode(...body.slice(1)) : "");
    offset += 10 + frameSize;
  }

  return { frames, audioAt: end };
}

/** The body of the one metadata block of this type. */
function blockOfType(bytes: Uint8Array, type: number): Uint8Array {
  const block = readFlacBlocks(bytes).find((candidate) => candidate.type === type);
  if (!block) {
    throw new Error(`the FLAC fixture has no block of type ${type}`);
  }

  return block.body;
}

interface FlacBlock {
  readonly type: number;
  readonly last: boolean;
  readonly body: Uint8Array;
}

function readFlacBlocks(bytes: Uint8Array): FlacBlock[] {
  const blocks: FlacBlock[] = [];
  let offset = 4;

  while (offset + 4 <= bytes.length) {
    const header = bytes[offset] as number;
    const length =
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number);
    const block = {
      type: header & 0x7f,
      last: (header & 0x80) !== 0,
      body: bytes.slice(offset + 4, offset + 4 + length),
    };
    blocks.push(block);
    offset += 4 + length;
    if (block.last) break;
  }

  return blocks;
}

function readVorbisComments(block: Uint8Array): Map<string, string> {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const decoder = new TextDecoder();
  const comments = new Map<string, string>();

  let offset = 4 + view.getUint32(0, true);
  const count = view.getUint32(offset, true);
  offset += 4;

  for (let index = 0; index < count; index++) {
    const length = view.getUint32(offset, true);
    const comment = decoder.decode(block.slice(offset + 4, offset + 4 + length));
    const equals = comment.indexOf("=");
    comments.set(comment.slice(0, equals), comment.slice(equals + 1));
    offset += 4 + length;
  }

  return comments;
}

/** The body of the one child atom of this type, which must be there. */
function atomBody(bytes: Uint8Array, type: string): Uint8Array {
  const atom = readAtoms(bytes).find((candidate) => candidate.type === type);
  if (!atom) {
    throw new Error(`no ${type} atom`);
  }

  return atom.body;
}

interface Mp4Atom {
  readonly type: string;
  readonly size: number;
  readonly offset: number;
  readonly body: Uint8Array;
}

function readAtoms(bytes: Uint8Array): Mp4Atom[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const atoms: Mp4Atom[] = [];

  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > bytes.length) {
      throw new Error(`atom at ${offset} claims ${size} bytes`);
    }

    atoms.push({
      type: String.fromCharCode(...bytes.slice(offset + 4, offset + 8)),
      size,
      offset,
      body: bytes.slice(offset + 8, offset + size),
    });
    offset += size;
  }

  return atoms;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function indexOfPngSignature(bytes: Uint8Array): number {
  for (let offset = 0; offset + PNG_SIGNATURE.length <= bytes.length; offset++) {
    if (PNG_SIGNATURE.every((byte, index) => bytes[offset + index] === byte)) {
      return offset;
    }
  }

  return -1;
}
