/**
 * The `Content-Disposition` a download carries.
 *
 * Navidrome sends `attachment; filename="<name>"` (server/subsonic/stream.go)
 * with the file's own name. That is enough for an ASCII name and loses the
 * rest: a quoted string may hold only ISO-8859-1, so "Café Sonore.mp3" would
 * reach the client mangled. RFC 6266 §4.1 answers exactly this with a second,
 * encoded parameter — `filename*=UTF-8''...`, defined by RFC 8187 — which a
 * recipient that understands it prefers over the plain one. A name that needs
 * nothing more than the plain parameter is sent with the plain parameter
 * alone, as Navidrome sends it.
 */

/** Characters a quoted-string cannot carry, and what stands in for them. */
const UNQUOTABLE = /[^\x20-\x7e]|["\\]/g;

/**
 * Characters `encodeURIComponent` leaves alone that RFC 8187's `attr-char`
 * does not allow, so they have to be percent-encoded after it.
 */
const NOT_ATTR_CHAR = /['()*]/g;

/** `attachment`, naming the file the bytes should be saved as. */
export function attachmentDisposition(fileName: string): string {
  const ascii = asciiFallback(fileName);
  const disposition = `attachment; filename="${ascii}"`;

  // The encoded form says nothing new when the name survived unchanged.
  return ascii === fileName ? disposition : `${disposition}; filename*=UTF-8''${encoded(fileName)}`;
}

/** The name of the file an R2 key names: everything after the last slash. */
export function baseName(r2Key: string): string {
  return r2Key.slice(r2Key.lastIndexOf("/") + 1);
}

/**
 * The name as a quoted-string can carry it: printable ASCII, with everything
 * else — accented letters, control characters, the quote and the backslash
 * that would end or escape the string — replaced by an underscore.
 */
function asciiFallback(fileName: string): string {
  return fileName.replace(UNQUOTABLE, "_");
}

/** The name as RFC 8187 encodes it, after the `UTF-8''` prefix. */
function encoded(fileName: string): string {
  return encodeURIComponent(fileName).replace(
    NOT_ATTR_CHAR,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
