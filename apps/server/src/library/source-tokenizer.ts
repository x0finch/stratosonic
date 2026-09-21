/**
 * A strtok3 tokenizer that reads from a `ByteSource`.
 *
 * `music-metadata` parses through strtok3's `ITokenizer`: an object that can
 * read a token here, peek a header there, and skip forward. strtok3 ships
 * tokenizers over a buffer, a file and a Blob - all of which want the whole
 * object in hand. This one wants a range at a time, which is what the scanner
 * can afford to give it.
 *
 * Declaring random access is the point of it. A tokenizer that supports random
 * access lets the parsers seek: the MP4 parser steps over an `mdat` of
 * megabytes by moving the position rather than by reading it, which is what
 * makes a trailing `moov` cost a read of the tail instead of a read of the
 * file. It also lets `music-metadata` look for an ID3v1 or APEv2 tag at the
 * end, which is two small reads of the last bytes and finds tags a head-only
 * parse would miss.
 */

import {
  AbstractTokenizer,
  EndOfStreamError,
  type IRandomAccessTokenizer,
  type IReadChunkOptions,
} from "strtok3/core";
import type { ByteSource } from "./byte-source";

export class ByteSourceTokenizer extends AbstractTokenizer implements IRandomAccessTokenizer {
  override readonly fileInfo: { size: number; mimeType?: string };

  private readonly source: ByteSource;

  constructor(source: ByteSource, mimeType?: string) {
    super();
    this.source = source;
    this.fileInfo =
      mimeType === undefined ? { size: source.size } : { size: source.size, mimeType };
  }

  supportsRandomAccess(): boolean {
    return true;
  }

  setPosition(position: number): void {
    this.position = position;
  }

  async readBuffer(target: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    if (options?.position !== undefined) {
      this.position = options.position;
    }

    const read = await this.peekBuffer(target, options);
    this.position += read;

    return read;
  }

  async peekBuffer(target: Uint8Array, options?: IReadChunkOptions): Promise<number> {
    const normalized = this.normalizeOptions(target, options);
    const wanted = Math.min(this.source.size - normalized.position, normalized.length);
    if (wanted < normalized.length && !normalized.mayBeLess) {
      throw new EndOfStreamError();
    }
    if (wanted <= 0) {
      return 0;
    }

    const chunk = await this.source.read(normalized.position, wanted);
    if (chunk.length < normalized.length && !normalized.mayBeLess) {
      // The source is shorter than it claimed: a truncated object.
      throw new EndOfStreamError();
    }
    target.set(chunk, 0);

    return chunk.length;
  }
}
