/**
 * The `Range` header of a media request, parsed by hand.
 *
 * R2 will not do this for us: `get()` takes a range as an offset and a length,
 * throws if that range lies outside the object, and `writeHttpMetadata` writes
 * neither `Content-Range` nor `Accept-Ranges`. So the header is read here, the
 * answer decided against the size `head()` reported, and only a range that is
 * known to be satisfiable is ever passed to R2 (as in `kotx/render`, which
 * serves R2 objects over ranges the same way).
 *
 * Only a single range is supported, which is all R2 can serve and all a player
 * asks for. RFC 9110 §14.2 lets a recipient ignore a `Range` it does not
 * understand and answer with the whole representation, so anything malformed —
 * a unit other than bytes, several ranges, digits that are not digits — is
 * served in full rather than refused; an unsatisfiable range, on the other
 * hand, is an error the client has to hear about (§15.5.17).
 */

/** What a request asks for: everything, one stretch of bytes, or nothing. */
export type ByteRange =
  | { readonly kind: "full" }
  | { readonly kind: "partial"; readonly offset: number; readonly length: number }
  | { readonly kind: "unsatisfiable" };

const FULL: ByteRange = { kind: "full" };
const UNSATISFIABLE: ByteRange = { kind: "unsatisfiable" };

/** `bytes=<spec>`; the unit is case-insensitive, as RFC 9110 §14.1 says. */
const BYTES_RANGES = /^bytes=(.*)$/i;

/** `first-last`, `first-` or `-suffix`, and nothing else. */
const RANGE_SPEC = /^(\d*)-(\d*)$/;

/**
 * Reads the `Range` header of a request for an object of `size` bytes.
 *
 * A satisfiable range always becomes a `partial`, including `bytes=0-`, which
 * asks for the whole object and is answered with a 206 and a `Content-Range`
 * covering all of it — the range is valid, and a client that sends it is
 * asking to be told that ranges work.
 */
export function parseByteRange(header: string | null, size: number): ByteRange {
  if (header === null) {
    return FULL;
  }

  const ranges = BYTES_RANGES.exec(header.trim());
  if (!ranges) {
    return FULL;
  }

  // R2 serves one range per request, so a multi-range ask is answered whole
  // rather than partially honoured.
  const spec = RANGE_SPEC.exec((ranges[1] ?? "").trim());
  if (!spec) {
    return FULL;
  }

  const first = spec[1] ?? "";
  const last = spec[2] ?? "";

  return first === "" ? suffixRange(last, size) : offsetRange(first, last, size);
}

/** `bytes=-n`: the last `n` bytes, clamped to an object smaller than that. */
function suffixRange(last: string, size: number): ByteRange {
  if (last === "") {
    // "bytes=-" names neither end and is malformed, not unsatisfiable.
    return FULL;
  }

  const length = Math.min(Number(last), size);

  // The last zero bytes of anything, and any suffix of an empty object, are
  // the one unsatisfiable suffix range (RFC 9110 §14.1.2).
  return length === 0 ? UNSATISFIABLE : { kind: "partial", offset: size - length, length };
}

/** `bytes=a-b` or `bytes=a-`: from `a`, to `b` or to the end. */
function offsetRange(first: string, last: string, size: number): ByteRange {
  const offset = Number(first);
  if (offset >= size) {
    return UNSATISFIABLE;
  }

  if (last === "") {
    return { kind: "partial", offset, length: size - offset };
  }

  const end = Number(last);
  if (end < offset) {
    // A range that ends before it starts is malformed, so it is ignored.
    return FULL;
  }

  // A range may run past the end; it then reaches only as far as the object.
  return { kind: "partial", offset, length: Math.min(end, size - 1) - offset + 1 };
}

/** The `Content-Range` of a partial response: `bytes <first>-<last>/<size>`. */
export function contentRange(offset: number, length: number, size: number): string {
  return `bytes ${offset}-${offset + length - 1}/${size}`;
}

/** The `Content-Range` a 416 carries: the size is all it can report. */
export function unsatisfiedContentRange(size: number): string {
  return `bytes */${size}`;
}
