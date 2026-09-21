/**
 * Vite's asset imports, as the fixtures use them.
 *
 * The committed fixture files are read through Vite rather than from disk:
 * tests run inside workerd, which has no file system. `?inline` hands back a
 * base64 data URI, which is lossless for the audio files; `?raw` hands back the
 * text of the `.m3u`.
 */

declare module "*?inline" {
  const dataUri: string;
  export default dataUri;
}

declare module "*?raw" {
  const text: string;
  export default text;
}
