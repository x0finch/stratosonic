import { SELF } from "cloudflare:test";
import { database } from "../src/db";
import { findUserByUsername } from "../src/users/repository";
import type {
  SubsonicAlbumElement,
  SubsonicArtistElement,
  SubsonicSongElement,
} from "./browsing-support";
import { ADMIN, query } from "./browsing-support";
import { BASE, testEnv } from "./support";

/**
 * What the Lists tests send and what they read back.
 *
 * The element shapes are the Browsing ones - `getAlbumList2` and
 * `getStarred2` carry Navidrome's `AlbumID3`, `ArtistID3` and `Child`, the
 * same elements `getAlbum` and `getArtist` do - so they are imported rather
 * than restated, and only the containers are new here.
 */

export interface ListsResponse {
  status: string;
  error?: { code: number; message: string };
  albumList2?: { album?: SubsonicAlbumElement[] };
  randomSongs?: { song?: SubsonicSongElement[] };
  starred2?: {
    artist?: SubsonicArtistElement[];
    album?: SubsonicAlbumElement[];
    song?: SubsonicSongElement[];
  };
}

/** Calls a list endpoint as the bootstrap admin and reads the JSON answer. */
export async function list(
  endpoint: string,
  extra: Record<string, string> = {},
): Promise<ListsResponse> {
  const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${query({ ...extra, f: "json" })}`);
  const body = (await response.json()) as { "subsonic-response": ListsResponse };

  return body["subsonic-response"];
}

/** Calls a list endpoint as some other user, to prove whose rows come back. */
export async function listAs(
  credentials: { readonly user: string; readonly password: string },
  endpoint: string,
  extra: Record<string, string> = {},
): Promise<ListsResponse> {
  const params = new URLSearchParams({
    u: credentials.user,
    p: credentials.password,
    v: "1.16.1",
    c: "Substreamer",
    f: "json",
    ...extra,
  });
  const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${params.toString()}`);
  const body = (await response.json()) as { "subsonic-response": ListsResponse };

  return body["subsonic-response"];
}

/**
 * The id of the bootstrap admin, which annotations have to be keyed by: the
 * `annotation` table references `user`, so a starred row invented for a user
 * that does not exist is rejected outright. Call it after `bootstrapAdmin`.
 */
export async function adminUserId(): Promise<string> {
  const user = await findUserByUsername(database(testEnv), ADMIN);
  if (!user) {
    throw new Error("the bootstrap admin has not been created yet");
  }

  return user.id;
}

/** The albums of a list, by name, which is how a test states an ordering. */
export function albumNames(response: ListsResponse): string[] {
  return (response.albumList2?.album ?? []).map((album) => album.name);
}
