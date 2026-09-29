import { SELF } from "cloudflare:test";
import { type FixtureAlbum, fixtures } from "./fixtures/files";
import { BASE } from "./support";

/**
 * What the Browsing tests send and what they read back.
 *
 * The endpoints are reached through the Worker, as the bootstrap admin the
 * test bindings create, so each test asserts on what a client would actually
 * receive. The element shapes below are the JSON rendering of Navidrome's
 * `ArtistID3`, `AlbumID3`, `Child` and `Genre`.
 */

/** The bootstrap admin from vitest.config.ts. */
export const ADMIN = "admin";
const PASSWORD = "sesame";

export interface SubsonicArtistElement {
  id: string;
  name: string;
  coverArt?: string;
  albumCount: number;
  starred?: string;
  playCount?: number;
  played?: string;
  userRating?: number;
  album?: SubsonicAlbumElement[];
}

export interface SubsonicAlbumElement {
  id: string;
  name: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount: number;
  duration: number;
  playCount?: number;
  created: string;
  starred?: string;
  year?: number;
  genre?: string;
  played?: string;
  userRating?: number;
  song?: SubsonicSongElement[];
}

export interface SubsonicSongElement {
  id: string;
  parent?: string;
  isDir: boolean;
  title: string;
  album?: string;
  artist?: string;
  track?: number;
  year?: number;
  genre?: string;
  coverArt?: string;
  size?: number;
  contentType?: string;
  suffix?: string;
  starred?: string;
  duration?: number;
  bitRate?: number;
  path?: string;
  playCount?: number;
  played?: string;
  discNumber?: number;
  created: string;
  albumId?: string;
  artistId?: string;
  type?: string;
  userRating?: number;
}

/**
 * A `<child>` of a `<directory>`: a track, or an album shown as a
 * sub-directory, which carries the two attributes a track never does.
 */
export interface SubsonicChildElement extends SubsonicSongElement {
  name?: string;
  songCount?: number;
}

/** `<artist>` inside `<indexes>`: Navidrome's `Artist`, which has no count. */
export interface SubsonicIndexArtistElement {
  id: string;
  name: string;
  coverArt?: string;
  starred?: string;
  userRating?: number;
}

/** `<directory>`: its attributes, and the children folder browsing lists. */
export interface SubsonicDirectoryElement {
  id: string;
  name: string;
  parent?: string;
  starred?: string;
  playCount?: number;
  played?: string;
  userRating?: number;
  coverArt?: string;
  songCount?: number;
  albumCount?: number;
  child?: SubsonicChildElement[];
}

/** The name is the element's text, which JSON carries as `value`. */
export interface SubsonicGenreElement {
  value: string;
  songCount: number;
  albumCount: number;
}

export interface BrowsingResponse {
  status: string;
  version: string;
  error?: { code: number; message: string };
  artists?: {
    ignoredArticles: string;
    index?: { name: string; artist: SubsonicArtistElement[] }[];
  };
  artist?: SubsonicArtistElement;
  album?: SubsonicAlbumElement;
  song?: SubsonicSongElement;
  genres?: { genre?: SubsonicGenreElement[] };
  musicFolders?: { musicFolder?: { id: number; name: string }[] };
  indexes?: {
    lastModified: number;
    ignoredArticles: string;
    index?: { name: string; artist: SubsonicIndexArtistElement[] }[];
  };
  directory?: SubsonicDirectoryElement;
}

/** Credentials plus whatever the call needs, as a query string. */
export function query(extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    u: ADMIN,
    p: PASSWORD,
    v: "1.16.1",
    c: "Substreamer",
    ...extra,
  }).toString();
}

/** Calls an endpoint and reads the JSON rendering of the answer. */
export async function browse(
  endpoint: string,
  extra: Record<string, string> = {},
): Promise<BrowsingResponse> {
  const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${query({ ...extra, f: "json" })}`);
  const body = (await response.json()) as { "subsonic-response": BrowsingResponse };

  return body["subsonic-response"];
}

/**
 * Calls a full path and reads the XML rendering, which is the default. The
 * path is given whole so a test can ask for both URL forms of an endpoint.
 */
export async function browseXml(path: string, extra: Record<string, string> = {}): Promise<string> {
  return (await SELF.fetch(`${BASE}${path}?${query(extra)}`)).text();
}

/**
 * Lets the Worker create the bootstrap admin, which it only does while the
 * user table is empty, before anything else runs.
 */
export async function bootstrapAdmin(): Promise<void> {
  await SELF.fetch(`${BASE}/rest/ping`);
}

/**
 * The album fixture of this name, as the manifest describes it. The manifest
 * lists albums in an array; looking one up by name keeps a test readable and
 * independent of that order.
 */
export function fixtureAlbum(name: string): FixtureAlbum {
  const album = fixtures.albums.find((candidate) => candidate.name === name);
  if (!album) {
    throw new Error(`no album fixture named ${name}`);
  }

  return album;
}
