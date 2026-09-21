import { describe, expect, it } from "vitest";
import {
  type ByteRange,
  contentRange,
  parseByteRange,
  unsatisfiedContentRange,
} from "../src/media/range";

/**
 * The `Range` parser, against the matrix #13 asks for. The size stands in for
 * a track of 1000 bytes, so a suffix range larger than the object and a first
 * byte past its end are both reachable.
 */

const SIZE = 1000;

function parse(header: string | null, size = SIZE): ByteRange {
  return parseByteRange(header, size);
}

describe("a request without a usable Range", () => {
  it("asks for the whole object when there is no header", () => {
    expect(parse(null)).toEqual({ kind: "full" });
  });

  it.each([
    ["an empty header", ""],
    ["a header with no unit", "0-1"],
    ["a unit that is not bytes", "items=0-1"],
    ["a byte unit with nothing after it", "bytes="],
    ["a range made of letters", "bytes=abc"],
    ["a range with neither end", "bytes=-"],
    ["a range that ends before it starts", "bytes=500-100"],
    ["a range with a sign", "bytes=+100-200"],
    ["a third dash", "bytes=1-2-3"],
    ["several ranges", "bytes=0-1,4-5"],
    ["a suffix among several ranges", "bytes=0-1, -5"],
  ])("serves the whole object for %s", (_case, header) => {
    expect(parse(header)).toEqual({ kind: "full" });
  });
});

describe("a satisfiable Range", () => {
  it("reads the first two bytes of bytes=0-1", () => {
    expect(parse("bytes=0-1")).toEqual({ kind: "partial", offset: 0, length: 2 });
  });

  it("reads to the end for an open range", () => {
    expect(parse("bytes=100-")).toEqual({ kind: "partial", offset: 100, length: 900 });
  });

  it("answers bytes=0- with the whole object as a partial response", () => {
    expect(parse("bytes=0-")).toEqual({ kind: "partial", offset: 0, length: SIZE });
  });

  it("reads the last bytes of a suffix range", () => {
    expect(parse("bytes=-500")).toEqual({ kind: "partial", offset: 500, length: 500 });
  });

  it("clamps a suffix larger than the object to the object", () => {
    expect(parse("bytes=-5000")).toEqual({ kind: "partial", offset: 0, length: SIZE });
  });

  it("reads a range that ends at the last byte", () => {
    expect(parse("bytes=998-999")).toEqual({ kind: "partial", offset: 998, length: 2 });
  });

  it("stops at the last byte of a range that runs past the end", () => {
    expect(parse("bytes=900-5000")).toEqual({ kind: "partial", offset: 900, length: 100 });
  });

  it("reads the last byte alone", () => {
    expect(parse("bytes=999-999")).toEqual({ kind: "partial", offset: 999, length: 1 });
  });

  it("ignores the case of the unit and the space around the range", () => {
    expect(parse(" BYTES= 0-1 ")).toEqual({ kind: "partial", offset: 0, length: 2 });
  });
});

describe("an unsatisfiable Range", () => {
  it("refuses a first byte at the end of the object", () => {
    expect(parse("bytes=1000-")).toEqual({ kind: "unsatisfiable" });
  });

  it("refuses a first byte past the end of the object", () => {
    expect(parse("bytes=5000-6000")).toEqual({ kind: "unsatisfiable" });
  });

  it("refuses a suffix of nothing", () => {
    expect(parse("bytes=-0")).toEqual({ kind: "unsatisfiable" });
  });

  it("refuses every range of an empty object", () => {
    expect(parse("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parse("bytes=-1", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("refuses a first byte no number could reach", () => {
    expect(parse("bytes=99999999999999999999999-")).toEqual({ kind: "unsatisfiable" });
  });
});

describe("the Content-Range a response carries", () => {
  it("names the first and last byte and the size", () => {
    expect(contentRange(0, 2, SIZE)).toBe("bytes 0-1/1000");
    expect(contentRange(100, 900, SIZE)).toBe("bytes 100-999/1000");
  });

  it("names only the size when nothing could be served", () => {
    expect(unsatisfiedContentRange(SIZE)).toBe("bytes */1000");
  });
});
