import { SELF } from "cloudflare:test";
import type {
  SubsonicAlbumElement,
  SubsonicArtistElement,
  SubsonicChildElement,
  SubsonicIndexArtistElement,
  SubsonicSongElement,
} from "./browsing-support";
import { query } from "./browsing-support";
import { BASE } from "./support";

/**
 * What the Search tests send and read back.
 *
 * `search3` carries the ID3 elements — `ArtistID3`, `AlbumID3`, `Child` — the
 * browsing tests already describe, and `search2` carries the folder view's
 * `Artist` (no count) and its albums as `<child>` directories, so both element
 * sets are imported rather than restated. Only the containers are new.
 */

export interface SearchResponse {
  status: string;
  error?: { code: number; message: string };
  searchResult3?: {
    artist?: SubsonicArtistElement[];
    album?: SubsonicAlbumElement[];
    song?: SubsonicSongElement[];
  };
  searchResult2?: {
    artist?: SubsonicIndexArtistElement[];
    album?: SubsonicChildElement[];
    song?: SubsonicSongElement[];
  };
}

/** Calls a search endpoint as the bootstrap admin and reads the JSON answer. */
export async function search(
  endpoint: string,
  extra: Record<string, string> = {},
): Promise<SearchResponse> {
  const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${query({ ...extra, f: "json" })}`);
  const body = (await response.json()) as { "subsonic-response": SearchResponse };

  return body["subsonic-response"];
}

/** Calls a full path and reads the XML rendering, which is the default. */
export async function searchXml(path: string, extra: Record<string, string> = {}): Promise<string> {
  return (await SELF.fetch(`${BASE}${path}?${query(extra)}`)).text();
}

/** Posts the parameters as a form body, the other way a client may call. */
export async function searchByPost(
  endpoint: string,
  extra: Record<string, string> = {},
): Promise<SearchResponse> {
  const response = await SELF.fetch(`${BASE}/rest/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: query({ ...extra, f: "json" }),
  });
  const body = (await response.json()) as { "subsonic-response": SearchResponse };

  return body["subsonic-response"];
}

/** The names of the artists a search returned, in the order they came back. */
export function artistNames(result: SearchResponse["searchResult3"]): string[] {
  return (result?.artist ?? []).map((artist) => artist.name);
}

/** The names of the albums a search returned, in order. */
export function albumNames(result: SearchResponse["searchResult3"]): string[] {
  return (result?.album ?? []).map((album) => album.name);
}

/** The titles of the songs a search returned, in order. */
export function songTitles(
  result: SearchResponse["searchResult3"] | SearchResponse["searchResult2"],
): string[] {
  return (result?.song ?? []).map((song) => song.title);
}
