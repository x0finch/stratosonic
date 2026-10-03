/**
 * `ListObjectsV2` answers for the S3 benches (bench-files.ts and
 * bench-s3-list-workerd.ts): a page of `n` entries as R2 writes one with
 * `encoding-type=url`, every key past a folder prefix in non-ASCII, so each
 * key is URL-decoded in full, the parser's worst case. Of the entries, 2%
 * are common prefixes, as a music folder's disc subfolders are.
 */

const PREFIX = "Some Artist With A Long Name/Some Album (2024) [FLAC 24-96]/";
const ETAG = "0123456789abcdef0123456789abcdef";

/** S3's `encoding-type=url`: a form encoding that keeps `/`. */
function s3UrlEncode(value: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const character = String.fromCharCode(byte);
    encoded +=
      character === " "
        ? "+"
        : /^[A-Za-z0-9\-_.~/]$/.test(character)
          ? character
          : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/** A listing page of `n` entries, truncated, as R2 answers it. */
export function listingXml(n: number): string {
  const folders = Math.floor(n / 50);
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    `<Name>archive</Name><Prefix>${s3UrlEncode(PREFIX)}</Prefix><KeyCount>${n}</KeyCount>`,
    "<MaxKeys>1000</MaxKeys><Delimiter>/</Delimiter><EncodingType>url</EncodingType>",
    "<IsTruncated>true</IsTruncated>",
    "<NextContinuationToken>1ZJKzqYmXwqVhB6p7r0bE4yG5c2aT9dL8sN3uK6fQ0vW+oP/IxMhRjSgCeDnFbUyAtZl==</NextContinuationToken>",
  ];
  for (let index = 0; index < n - folders; index++) {
    const key = `${PREFIX}${String(index).padStart(4, "0")} Ünïcödé Träck Tïtlé Of Middling Length.${
      ["flac", "lrc", "jpg", "m3u", "cue"][index % 5]
    }`;
    parts.push(
      `<Contents><Key>${s3UrlEncode(key)}</Key><LastModified>2026-10-02T06:00:00.${String(
        index % 1000,
      ).padStart(3, "0")}Z</LastModified><ETag>&quot;${ETAG}&quot;</ETag><Size>${
        41_234_567 + index
      }</Size><StorageClass>STANDARD</StorageClass></Contents>`,
    );
  }
  for (let index = 0; index < folders; index++) {
    parts.push(
      `<CommonPrefixes><Prefix>${s3UrlEncode(`${PREFIX}CD${index + 1}/`)}</Prefix></CommonPrefixes>`,
    );
  }
  parts.push("</ListBucketResult>");
  return parts.join("");
}

/** The folder the listing is of. */
export const LISTING_PREFIX = PREFIX;
