import { StorageError, type StorageListing, type StoredObject } from "./storage";

/**
 * A `ListObjectsV2` answer (S3 API Reference, "ListObjectsV2", Response
 * Syntax) read into a `StorageListing` (#84, "Storage interface").
 *
 * Workers have no `DOMParser`, and seven elements do not justify an XML
 * library, so this is a small scanner over the body built for that one
 * shape: `Contents` (`Key`, `Size`, `ETag`, `LastModified`),
 * `CommonPrefixes/Prefix`, `IsTruncated`, `NextContinuationToken` and
 * `EncodingType`. Everything else (`Name`, `KeyCount`, `StorageClass`,
 * `Owner` and the rest) is skipped.
 *
 * - **Entities.** Text is unescaped from XML's five named entities and its
 *   character references. Any other entity is malformed XML.
 * - **URL decoding.** The client asks for `encoding-type=url`, since XML 1.0
 *   cannot carry a key's control characters. Keys and prefixes are then
 *   decoded as S3 encodes them, a form encoding (`+` for a space, `%2B` for
 *   a plus), which is how botocore (`unquote_plus`) and rclone
 *   (`url.QueryUnescape`) read them from R2 too. They are decoded only when
 *   the answer says `<EncodingType>url</EncodingType>`, so a server that
 *   ignored the parameter cannot have a literal `%` or `+` mangled. The
 *   continuation token is opaque and never URL-encoded.
 * - **Strictness.** A body with no `<ListBucketResult>`, no closing tag, no
 *   `<IsTruncated>`, a truncated page with no `<NextContinuationToken>`, or
 *   an entry missing a field is `unavailable`, never an empty last page: a
 *   scan that took a garbled answer for the end of the bucket would sweep
 *   every track after it.
 *
 * CPU is gated by a bench, <= 4 ms per 1,000 entries in workerd
 * (scripts/bench-s3-list-workerd.ts, and bench-files.ts in Node): a handful
 * of `indexOf` calls an entry, a page's shared folder decoded once, and
 * decoding only where a value needs it.
 */

/** Reads a `ListObjectsV2` body, or throws `StorageError("unavailable")`. */
export function parseListObjectsV2(xml: string): StorageListing {
  const root = openingTag(xml, "ListBucketResult", 0);
  if (root === -1) {
    throw malformed("no <ListBucketResult>");
  }
  const end = xml.lastIndexOf("</ListBucketResult>");
  if (end < root) {
    throw malformed("no </ListBucketResult>");
  }

  const truncatedText = element(xml, "IsTruncated", root, end);
  if (truncatedText === null) {
    throw malformed("no <IsTruncated>");
  }
  if (truncatedText !== "true" && truncatedText !== "false") {
    throw malformed("<IsTruncated> is neither true nor false");
  }
  const truncated = truncatedText === "true";

  let cursor: string | null = null;
  if (truncated) {
    const token = element(xml, "NextContinuationToken", root, end);
    if (token === null || token === "") {
      throw malformed("a truncated page with no <NextContinuationToken>");
    }
    cursor = unescapeXml(token);
  }

  const encoded = element(xml, "EncodingType", root, end) === "url";
  // The keys of a page mostly share their folders, so the last folder
  // decoded is kept: a key in it decodes only its name. A `/` is never part
  // of a multi-byte character, so a key splits there into parts that decode
  // apart exactly as they decode together.
  let folder = "";
  let decodedFolder = "";
  const name = (text: string) => {
    const unescaped = unescapeXml(text);
    if (!encoded) {
      return unescaped;
    }
    const slash = unescaped.lastIndexOf("/") + 1;
    if (slash === 0) {
      return urlDecode(unescaped);
    }
    if (slash !== folder.length || !unescaped.startsWith(folder)) {
      folder = unescaped.slice(0, slash);
      decodedFolder = urlDecode(folder);
    }
    return decodedFolder + urlDecode(unescaped.slice(slash));
  };

  const objects: StoredObject[] = [];
  for (let at = xml.indexOf("<Contents>", root); at !== -1 && at < end; ) {
    const close = xml.indexOf("</Contents>", at);
    if (close === -1 || close > end) {
      throw malformed("an unclosed <Contents>");
    }
    objects.push(entry(xml, at + 10, close, name));
    at = xml.indexOf("<Contents>", close + 11);
  }

  const prefixes: string[] = [];
  for (let at = xml.indexOf("<CommonPrefixes>", root); at !== -1 && at < end; ) {
    const close = xml.indexOf("</CommonPrefixes>", at);
    if (close === -1 || close > end) {
      throw malformed("an unclosed <CommonPrefixes>");
    }
    const prefix = element(xml, "Prefix", at + 16, close);
    if (prefix === null) {
      throw malformed("a <CommonPrefixes> with no <Prefix>");
    }
    prefixes.push(name(prefix));
    at = xml.indexOf("<CommonPrefixes>", close + 17);
  }

  return { objects, prefixes, cursor };
}

/** One `<Contents>`, between its tags. */
function entry(
  xml: string,
  from: number,
  to: number,
  name: (text: string) => string,
): StoredObject {
  const key = element(xml, "Key", from, to);
  const size = element(xml, "Size", from, to);
  const etag = element(xml, "ETag", from, to);
  const lastModified = element(xml, "LastModified", from, to);
  if (key === null || size === null || etag === null || lastModified === null) {
    throw malformed("a <Contents> without its Key, Size, ETag or LastModified");
  }

  const bytes = Number(size);
  if (!/^\d+$/.test(size) || !Number.isSafeInteger(bytes)) {
    throw malformed("a <Size> that is not a whole number");
  }
  const uploaded = new Date(lastModified);
  if (Number.isNaN(uploaded.getTime())) {
    throw malformed("a <LastModified> that is not a date");
  }

  return { key: name(key), size: bytes, etag: etagText(etag), uploaded };
}

/** An `<ETag>`'s text, unquoted: `&quot;<hex>&quot;` as R2 writes it, at once. */
function etagText(text: string): string {
  if (
    text.startsWith("&quot;") &&
    text.endsWith("&quot;") &&
    text.length >= 12 &&
    text.indexOf("&", 6) === text.length - 6
  ) {
    return text.slice(6, -6);
  }
  return unquoteEtag(unescapeXml(text));
}

/** An entity tag without its quotes, as `StoredObject.etag` holds it. */
export function unquoteEtag(etag: string): string {
  return etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}

/**
 * Where `<name>` or `<name …>` opens, from `from`, or -1. Only the root
 * carries attributes (its namespace).
 */
function openingTag(xml: string, name: string, from: number): number {
  const tag = `<${name}`;
  for (let at = xml.indexOf(tag, from); at !== -1; at = xml.indexOf(tag, at + 1)) {
    const next = xml.charCodeAt(at + tag.length);
    // `>`, a space, a tab, a line feed or a carriage return.
    if (next === 62 || next === 32 || next === 9 || next === 10 || next === 13) {
      return at;
    }
  }
  return -1;
}

/**
 * The raw text of the first `<name>…</name>` between `from` and `to`, or
 * null. `<name/>`, an empty element, is the empty string.
 */
function element(xml: string, name: string, from: number, to: number): string | null {
  const open = `<${name}>`;
  const start = xml.indexOf(open, from);
  if (start === -1 || start >= to) {
    const empty = xml.indexOf(`<${name}/>`, from);
    return empty !== -1 && empty < to ? "" : null;
  }
  const textStart = start + open.length;
  const close = xml.indexOf(`</${name}>`, textStart);
  if (close === -1 || close > to) {
    throw malformed(`an unclosed <${name}>`);
  }
  return xml.slice(textStart, close);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Text unescaped from XML's entities and character references. */
export function unescapeXml(text: string): string {
  let at = text.indexOf("&");
  if (at === -1) {
    return text;
  }
  let unescaped = "";
  let from = 0;
  while (at !== -1) {
    const end = text.indexOf(";", at);
    const next = text.indexOf("&", at + 1);
    if (end === -1 || (next !== -1 && next < end)) {
      throw malformed("an unterminated entity");
    }
    unescaped += text.slice(from, at) + entity(text.slice(at + 1, end));
    from = end + 1;
    at = text.indexOf("&", from);
  }
  return unescaped + text.slice(from);
}

/** The character an entity's name (between `&` and `;`) stands for. */
function entity(name: string): string {
  const named = NAMED_ENTITIES[name];
  if (named !== undefined) {
    return named;
  }
  const code = /^#x[0-9a-fA-F]+$/.test(name)
    ? Number.parseInt(name.slice(2), 16)
    : /^#[0-9]+$/.test(name)
      ? Number.parseInt(name.slice(1), 10)
      : Number.NaN;
  if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    throw malformed(`an unknown entity &${name};`);
  }
  return String.fromCodePoint(code);
}

/**
 * Strict UTF-8: a key whose bytes are not UTF-8 is not a key R2 stores. A
 * leading byte-order mark is part of the key, as `decodeURIComponent` keeps
 * it.
 */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Where `urlDecode` gathers a key's bytes, grown as keys need. */
let scratch = new Uint8Array(1024);

/**
 * A key or prefix as `encoding-type=url` gave it: `+` is a space and `%XX`
 * a byte of its UTF-8. It decodes as `decodeURIComponent` does after `+` is
 * made a space, and refuses what it refuses (a bad escape, bytes that are
 * not UTF-8), at a fraction of its cost on keys that are mostly escapes
 * (non-Latin names): the bytes are gathered in one pass and decoded at once.
 */
export function urlDecode(text: string): string {
  if (text.indexOf("%") === -1) {
    return text.indexOf("+") === -1 ? text : text.replaceAll("+", " ");
  }
  if (scratch.length < text.length) {
    scratch = new Uint8Array(text.length * 2);
  }
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 37 /* % */) {
      const byte = hexByte(text, index + 1);
      if (byte === -1) {
        throw undecodable();
      }
      scratch[length++] = byte;
      index += 2;
    } else if (code === 43 /* + */) {
      scratch[length++] = 32;
    } else if (code < 0x80) {
      scratch[length++] = code;
    } else {
      // A character S3 would have escaped: decode it the general way.
      try {
        return decodeURIComponent(text.replaceAll("+", " "));
      } catch (cause) {
        throw undecodable(cause);
      }
    }
  }
  try {
    return utf8.decode(scratch.subarray(0, length));
  } catch (cause) {
    throw undecodable(cause);
  }
}

/** The byte two hex digits at `at` spell, or -1. */
function hexByte(text: string, at: number): number {
  const high = hexDigit(text.charCodeAt(at));
  const low = hexDigit(text.charCodeAt(at + 1));
  return high === -1 || low === -1 ? -1 : high * 16 + low;
}

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function undecodable(cause?: unknown): StorageError {
  return new StorageError("unavailable", "the listing carried a key that does not URL-decode", {
    cause,
  });
}

function malformed(what: string): StorageError {
  return new StorageError("unavailable", `the listing is not a ListObjectsV2 answer: ${what}`);
}
