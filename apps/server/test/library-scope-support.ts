import { SELF } from "cloudflare:test";
import { albumId, artistId, library, trackId, userLibrary } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { createApp } from "../src/app";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { type CountingD1, countingD1, type RecordedStatement } from "./console-auth-support";
import {
  BASE,
  SEED_TIME,
  seedAlbum,
  seedAnnotation,
  seedArtist,
  seedTrack,
  seedUser,
  testEnv,
} from "./support";

/**
 * The fixtures of #84's library access tests ("Testing Decisions"): libraries
 * 1 and 2, written straight into D1 (no storage is called), with a key that
 * is in both and an artist whose albums are in both; and three users, the
 * bootstrap admin, a listener who sees library 2 only and one who sees both.
 *
 * Requests go through the Worker's app over a `countingD1` binding, so every
 * test can also read what a request cost.
 */

export const PASSWORD = "sesame";
export const ADMIN = "admin";
export const LISTENER_TWO = "two";
export const LISTENER_BOTH = "both";

/** Library 2, connected at runtime in production; here a row. */
export const ARCHIVE = { id: 2, name: "Archive" } as const;

/** One key, indexed in both libraries: two tracks, two albums, one artist. */
export const SHARED_KEY = "Shared Artist/Shared/01 Shared Song.flac";

export const ids = {
  sharedArtist: artistId("Shared Artist"),
  onlyOne: artistId("Only One"),
  onlyTwo: artistId("Only Two"),
  sharedAlbum1: albumId(1, "Shared Artist", "Shared", 2001),
  sharedAlbum2: albumId(2, "Shared Artist", "Shared", 2001),
  firstOnly: albumId(1, "Only One", "First Only", 1999),
  secondOnly: albumId(2, "Only Two", "Second Only", 2010),
  sharedTrack1: trackId(1, SHARED_KEY),
  sharedTrack2: trackId(2, SHARED_KEY),
  jazzTrack: trackId(1, "Only One/First Only/01 Jazz.flac"),
  calmTrack: trackId(2, "Only Two/Second Only/01 Calm.flac"),
} as const;

/** The libraries each fixture item is in, keyed by its client id. */
export const LIBRARIES_OF = new Map<string, readonly number[]>([
  [`ar-${ids.sharedArtist}`, [1, 2]],
  [`ar-${ids.onlyOne}`, [1]],
  [`ar-${ids.onlyTwo}`, [2]],
  [`al-${ids.sharedAlbum1}`, [1]],
  [`al-${ids.sharedAlbum2}`, [2]],
  [`al-${ids.firstOnly}`, [1]],
  [`al-${ids.secondOnly}`, [2]],
  [`tr-${ids.sharedTrack1}`, [1]],
  [`tr-${ids.sharedTrack2}`, [2]],
  [`tr-${ids.jazzTrack}`, [1]],
  [`tr-${ids.calmTrack}`, [2]],
]);

/** The fixture items a scope of these libraries sees, out of `candidates`. */
export function inLibraries(candidates: Iterable<string>, libraries: readonly number[]): string[] {
  return [...candidates]
    .filter((id) => (LIBRARIES_OF.get(id) ?? []).some((libraryId) => libraries.includes(libraryId)))
    .sort();
}

export interface ScopeUsers {
  readonly adminId: string;
  readonly twoId: string;
  readonly bothId: string;
}

/** Writes library 2 and the fixture library, and the three users. */
export async function seedTwoLibraries(): Promise<ScopeUsers> {
  const db = database(testEnv);
  // The bootstrap admin, made by the first request, with every library: it
  // is created before library 2, as a deployed server's admin was.
  await SELF.fetch(`${BASE}/rest/ping`);

  await db.insert(library).values({
    id: ARCHIVE.id,
    name: ARCHIVE.name,
    path: "s3://acct.r2.cloudflarestorage.com/archive",
    kind: "s3",
    defaultNewUsers: false,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  });

  for (const name of ["Shared Artist", "Only One", "Only Two"]) {
    await seedArtist({ name });
  }
  for (const libraryId of [1, 2]) {
    await seedAlbum({
      libraryId,
      name: "Shared",
      albumArtist: "Shared Artist",
      year: 2001,
      genre: "Rock",
      songCount: 1,
      coverKey: `_covers/${albumId(libraryId, "Shared Artist", "Shared", 2001)}.jpg`,
    });
    await seedTrack({
      libraryId,
      r2Key: SHARED_KEY,
      title: "Shared Song",
      album: "Shared",
      year: 2001,
      genre: "Rock",
    });
  }
  await seedAlbum({
    name: "First Only",
    albumArtist: "Only One",
    year: 1999,
    genre: "Jazz",
    songCount: 1,
  });
  await seedTrack({ r2Key: "Only One/First Only/01 Jazz.flac", year: 1999, genre: "Jazz" });
  await seedAlbum({
    libraryId: 2,
    name: "Second Only",
    albumArtist: "Only Two",
    year: 2010,
    genre: "Ambient",
    songCount: 1,
    coverKey: "_covers/second-only.jpg",
  });
  await seedTrack({
    libraryId: 2,
    r2Key: "Only Two/Second Only/01 Calm.flac",
    year: 2010,
    genre: "Ambient",
  });

  const [admin] = await testEnv.DB.prepare("select id from subsonic_user where is_admin = 1")
    .all<{ id: string }>()
    .then((result) => result.results);
  const adminId = admin?.id ?? "";
  // A new admin is given every library, so the bootstrap admin, made before
  // library 2, is given it here, as connecting a library will give it.
  await db.insert(userLibrary).values({ userId: adminId, libraryId: ARCHIVE.id });

  const twoId = await seedUser(LISTENER_TWO, PASSWORD);
  await db.delete(userLibrary).where(eq(userLibrary.userId, twoId));
  await db.insert(userLibrary).values({ userId: twoId, libraryId: ARCHIVE.id });

  const bothId = await seedUser(LISTENER_BOTH, PASSWORD);
  await db.insert(userLibrary).values({ userId: bothId, libraryId: ARCHIVE.id });

  // Every user stars, rates and has played everything, so the starred list
  // and the top songs have something in every library to leave out.
  for (const userId of [adminId, twoId, bothId]) {
    await seedAnnotation({ userId, itemId: ids.sharedArtist, itemType: "artist" });
    await seedAnnotation({ userId, itemId: ids.onlyOne, itemType: "artist" });
    await seedAnnotation({ userId, itemId: ids.onlyTwo, itemType: "artist" });
    for (const id of [ids.sharedAlbum1, ids.sharedAlbum2, ids.firstOnly, ids.secondOnly]) {
      await seedAnnotation({ userId, itemId: id, itemType: "album", playCount: 1 });
    }
    for (const id of [ids.sharedTrack1, ids.sharedTrack2, ids.jazzTrack, ids.calmTrack]) {
      await seedAnnotation({ userId, itemId: id, itemType: "track", rating: 5, playCount: 3 });
    }
  }

  return { adminId, twoId, bothId };
}

/** The Worker's app over a binding that records every statement. */
export function countingApp(): {
  readonly d1: CountingD1;
  call: (
    user: string,
    endpoint: string,
    params?: readonly (readonly [string, string])[],
  ) => Promise<SubsonicJson>;
  /** The same request, answered as it is: for the endpoints that send bytes. */
  fetch: (
    user: string,
    endpoint: string,
    params?: readonly (readonly [string, string])[],
    init?: RequestInit,
  ) => Promise<Response>;
} {
  const d1 = countingD1(testEnv.DB);
  const env: Env = { ...testEnv, DB: d1.binding };
  const app = createApp();

  const fetch = async (
    user: string,
    endpoint: string,
    params: readonly (readonly [string, string])[] = [],
    init?: RequestInit,
  ) => {
    const search = new URLSearchParams([
      ["u", user],
      ["p", PASSWORD],
      ["v", "1.16.1"],
      ["c", "Substreamer"],
      ["f", "json"],
      ...params.map(([name, value]): [string, string] => [name, value]),
    ]);
    return app.request(`${BASE}/rest/${endpoint}?${search}`, init, env);
  };

  return {
    d1,
    fetch,
    async call(user, endpoint, params = []) {
      const response = await fetch(user, endpoint, params);
      const body = (await response.json()) as { "subsonic-response": SubsonicJson };

      return body["subsonic-response"];
    },
  };
}

/** A `subsonic-response`, read loosely: each test picks what it needs. */
// biome-ignore lint/suspicious/noExplicitAny: a response of any endpoint, read by path.
export type SubsonicJson = Record<string, any>;

/** The client ids an endpoint answered with, of every kind, sorted. */
export function idsIn(body: SubsonicJson): string[] {
  const found = new Set<string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === "object") {
      const id = (value as { id?: unknown }).id;
      if (typeof id === "string" && LIBRARIES_OF.has(id)) {
        found.add(id);
      }
      Object.values(value).forEach(visit);
    }
  };
  visit(body);

  return [...found].sort();
}

/**
 * The statements a request ran besides authenticating: the user lookup is
 * the first, and it reads the libraries by design (#84, "Loaded with the
 * user").
 */
export function afterAuthentication(statements: readonly RecordedStatement[]) {
  expect(statements[0]?.sql).toMatch(/from "subsonic_user"/);
  return statements.slice(1);
}

/**
 * Whether any of these statements keeps to some libraries: a `library_id`
 * predicate, or a read of the library tables. Selecting an album's or a
 * track's `library_id` column, as every read of the whole row does, is not
 * one.
 */
export function namesALibrary(statements: readonly RecordedStatement[]): boolean {
  return statements.some((statement) =>
    /library_id"?\s+in\s*\(|\buser_library\b|\bfrom "?library\b/i.test(statement.sql),
  );
}
