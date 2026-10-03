import { describe, expect, it } from "vitest";
import { parseListObjectsV2, unescapeXml, urlDecode } from "../src/storage/s3-list";
import { StorageError } from "../src/storage/storage";

/**
 * Reading a `ListObjectsV2` answer (storage/s3-list.ts; #84, "Testing
 * Decisions", "XML parser"): entities, URL-decoded keys, prefixes, an empty
 * page, truncation, and a malformed body, which is `unavailable`.
 */

const XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/";

/** A listing as R2 answers one, around its entries. */
function listing(
  inner: string,
  {
    truncated = false,
    token,
    encoded = true,
  }: { truncated?: boolean; token?: string; encoded?: boolean } = {},
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="${XMLNS}">` +
    "<Name>archive</Name><Prefix></Prefix><MaxKeys>1000</MaxKeys>" +
    (encoded ? "<EncodingType>url</EncodingType>" : "") +
    `<IsTruncated>${truncated}</IsTruncated>` +
    (token === undefined ? "" : `<NextContinuationToken>${token}</NextContinuationToken>`) +
    inner +
    "</ListBucketResult>"
  );
}

function contents(key: string, size = 5, etag = "&quot;0123abcd&quot;"): string {
  return (
    `<Contents><Key>${key}</Key><LastModified>2026-10-02T12:34:56.789Z</LastModified>` +
    `<ETag>${etag}</ETag><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`
  );
}

function expectUnavailable(xml: string): void {
  let error: unknown;
  try {
    parseListObjectsV2(xml);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(StorageError);
  expect((error as StorageError).reason).toBe("unavailable");
}

describe("parseListObjectsV2", () => {
  it("reads each object's key, size, unquoted etag and upload time", () => {
    const page = parseListObjectsV2(listing(contents("Artist/01.flac", 41_234_567)));

    expect(page).toEqual({
      objects: [
        {
          key: "Artist/01.flac",
          size: 41_234_567,
          etag: "0123abcd",
          uploaded: new Date("2026-10-02T12:34:56.789Z"),
        },
      ],
      prefixes: [],
      cursor: null,
    });
  });

  it("reads common prefixes apart from the echoed top-level prefix", () => {
    const xml = listing(
      `${contents("top.flac")}<CommonPrefixes><Prefix>A/</Prefix></CommonPrefixes>` +
        "<CommonPrefixes><Prefix>B+C/</Prefix></CommonPrefixes>",
    ).replace("<Prefix></Prefix>", "<Prefix>ignored/</Prefix>");

    const page = parseListObjectsV2(xml);
    expect(page.objects.map((object) => object.key)).toEqual(["top.flac"]);
    expect(page.prefixes).toEqual(["A/", "B C/"]);
  });

  it("URL-decodes keys and prefixes as S3 encodes them, + as a space", () => {
    const page = parseListObjectsV2(
      listing(
        contents("AC%2BDC+%26+Friends/%231+100%25+%27Live%27.mp3") +
          contents("Bj%C3%B6rk/J%C3%B3ga.flac") +
          contents("control%01character.flac") +
          contents("Emoji+%F0%9F%8E%B5/a%20b") +
          "<CommonPrefixes><Prefix>%E5%9D%82%E6%9C%AC/</Prefix></CommonPrefixes>",
      ),
    );

    expect(page.objects.map((object) => object.key)).toEqual([
      "AC+DC & Friends/#1 100% 'Live'.mp3",
      "Björk/Jóga.flac",
      "control\u0001character.flac",
      "Emoji 🎵/a b",
    ]);
    expect(page.prefixes).toEqual(["坂本/"]);
  });

  it("decodes each key's own folder, whatever the key before it", () => {
    const page = parseListObjectsV2(
      listing(
        contents("A%2BB/1") +
          contents("A%2BB/2") +
          contents("A+B/3") +
          contents("A%2BB/C/4") +
          contents("A%2BB/5") +
          contents("top") +
          contents("%C3%A9/6"),
      ),
    );

    expect(page.objects.map((object) => object.key)).toEqual([
      "A+B/1",
      "A+B/2",
      "A B/3",
      "A+B/C/4",
      "A+B/5",
      "top",
      "é/6",
    ]);
  });

  it("leaves keys as they are when the answer is not URL-encoded", () => {
    const page = parseListObjectsV2(
      listing(contents("100% + more.flac") + contents("a%20b"), { encoded: false }),
    );

    expect(page.objects.map((object) => object.key)).toEqual(["100% + more.flac", "a%20b"]);
  });

  it("unescapes XML entities and character references", () => {
    const page = parseListObjectsV2(
      listing(
        contents(
          "Tom &amp; Jerry &lt;3&gt; &quot;x&quot; &apos;y&apos; &#233;&#x1F3B5;",
          1,
          '"quoted"',
        ),
        {
          encoded: false,
        },
      ),
    );

    expect(page.objects[0]?.key).toBe(`Tom & Jerry <3> "x" 'y' é🎵`);
    expect(page.objects[0]?.etag).toBe("quoted");
  });

  it("reads an empty last page", () => {
    expect(parseListObjectsV2(listing(""))).toEqual({ objects: [], prefixes: [], cursor: null });
    expect(
      parseListObjectsV2(
        `<ListBucketResult xmlns="${XMLNS}"><Name>a</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>`,
      ),
    ).toEqual({ objects: [], prefixes: [], cursor: null });
  });

  it("answers the next continuation token of a truncated page, unescaped and not URL-decoded", () => {
    const page = parseListObjectsV2(
      listing(contents("a"), { truncated: true, token: "1/abc+def%3D&amp;=" }),
    );

    expect(page.cursor).toBe("1/abc+def%3D&=");
  });

  it.each([
    ["no body", ""],
    ["an error document", "<Error><Code>InternalError</Code></Error>"],
    ["an HTML page", "<html><body>ListBucketResult</body></html>"],
    [
      "a similarly named root",
      "<ListBucketResults><IsTruncated>false</IsTruncated></ListBucketResults>",
    ],
    ["no <IsTruncated>", `<ListBucketResult xmlns="${XMLNS}"></ListBucketResult>`],
    ["no closing tag", `<ListBucketResult><IsTruncated>false</IsTruncated>${contents("a")}`],
    ["an <IsTruncated> that is not a boolean", listing("").replace(">false<", ">maybe<")],
    ["a truncated page with no token", listing(contents("a"), { truncated: true })],
    ["an unclosed <Contents>", listing("<Contents><Key>a</Key>")],
    ["an entry without its size", listing(contents("a").replace("<Size>5</Size>", ""))],
    ["an entry without its etag", listing(contents("a").replace(/<ETag>.*<\/ETag>/, ""))],
    ["a size that is not a number", listing(contents("a").replace(">5<", ">five<"))],
    ["a negative size", listing(contents("a").replace(">5<", ">-5<"))],
    [
      "a date that is not a date",
      listing(contents("a").replace("2026-10-02T12:34:56.789Z", "then")),
    ],
    ["an unknown entity", listing(contents("a&nbsp;b"))],
    ["a bare ampersand", listing(contents("a & b"))],
    ["a key that does not URL-decode", listing(contents("bad%E0%A4"))],
    ["a prefix-less <CommonPrefixes>", listing("<CommonPrefixes></CommonPrefixes>")],
  ])("is unavailable for %s, never an empty last page", (_, xml) => {
    expectUnavailable(xml);
  });
});

describe("the parser's decoders", () => {
  it("leave plain text untouched", () => {
    expect(unescapeXml("plain")).toBe("plain");
    expect(urlDecode("plain/key.flac")).toBe("plain/key.flac");
  });

  it("decode in XML's order: entities first, then the URL encoding", () => {
    expect(urlDecode(unescapeXml("a%26amp;b"))).toBe("a&amp;b");
    expect(urlDecode(unescapeXml("a&amp;b+c%2B"))).toBe("a&b c+");
  });

  it("URL-decode exactly as decodeURIComponent does once + is a space", () => {
    const samples = [
      "Bj%C3%B6rk/J%C3%B3ga.flac",
      "%E5%9D%82%E6%9C%AC%E9%BE%8D%E4%B8%80/%E9%9F%B3%E6%A5%BD",
      "Emoji+%F0%9F%8E%B5/a%21b%2Ac%28d%29e.lrc",
      "%EF%BB%BFleading-bom",
      "lower%c3%a9case%2bhex",
      "control%00%01%1F",
      "raw é, already decoded",
      "%25%2B%26",
    ];
    for (const sample of samples) {
      expect(urlDecode(sample)).toBe(decodeURIComponent(sample.replaceAll("+", " ")));
    }
  });

  it("refuse what decodeURIComponent refuses", () => {
    for (const bad of ["%", "%4", "%G0", "%C3", "%C3%28", "%E0%80%80", "%ED%A0%80", "%F8%80"]) {
      expect(() => decodeURIComponent(bad)).toThrow();
      expect(() => urlDecode(bad)).toThrow(StorageError);
    }
  });
});
