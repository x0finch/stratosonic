import { describe, expect, it } from "vitest";
import { attachmentDisposition, baseName } from "../src/media/content-disposition";

describe("the file name a download is saved as", () => {
  it("is the last segment of the R2 key", () => {
    expect(baseName("Silent Artist/Quiet Album/01 Silent Track.mp3")).toBe("01 Silent Track.mp3");
  });

  it("is the key itself when it names no directory", () => {
    expect(baseName("loose.mp3")).toBe("loose.mp3");
  });
});

describe("the Content-Disposition of a download", () => {
  it("names an ASCII file in the plain parameter alone, as Navidrome does", () => {
    expect(attachmentDisposition("01 Silent Track.mp3")).toBe(
      'attachment; filename="01 Silent Track.mp3"',
    );
  });

  it("adds the encoded parameter for a name a quoted string cannot carry", () => {
    expect(attachmentDisposition("01 Café Sonore.mp3")).toBe(
      "attachment; filename=\"01 Caf_ Sonore.mp3\"; filename*=UTF-8''01%20Caf%C3%A9%20Sonore.mp3",
    );
  });

  it("carries a name of nothing but non-ASCII characters", () => {
    expect(attachmentDisposition("静けさ.flac")).toBe(
      "attachment; filename=\"___.flac\"; filename*=UTF-8''%E9%9D%99%E3%81%91%E3%81%95.flac",
    );
  });

  it("replaces the quote and the backslash that would end the quoted string", () => {
    expect(attachmentDisposition('a"b\\c.mp3')).toBe(
      "attachment; filename=\"a_b_c.mp3\"; filename*=UTF-8''a%22b%5Cc.mp3",
    );
  });

  it("replaces control characters, including the ones that split a header", () => {
    expect(attachmentDisposition("a\r\nb.mp3")).toBe(
      "attachment; filename=\"a__b.mp3\"; filename*=UTF-8''a%0D%0Ab.mp3",
    );
  });

  it("encodes the characters RFC 8187 does not allow unescaped", () => {
    expect(attachmentDisposition("(a)'b*c.mp3")).toBe('attachment; filename="(a)\'b*c.mp3"');
  });

  it("encodes them in the parameter when the name needs one", () => {
    expect(attachmentDisposition("(é)'b*c.mp3")).toBe(
      "attachment; filename=\"(_)'b*c.mp3\"; filename*=UTF-8''%28%C3%A9%29%27b%2Ac.mp3",
    );
  });
});
