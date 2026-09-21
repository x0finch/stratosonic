import { env } from "cloudflare:test";
import {
  type Album,
  type Annotation,
  type AnnotationItemType,
  type Artist,
  album,
  albumId,
  annotation,
  artist,
  artistId,
  newRandomId,
  type Playlist,
  playlist,
  playlistId,
  playlistTrack,
  type Track,
  track,
  trackId,
} from "@stratosonic/db";
import { encryptPassword } from "../src/auth/crypto";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { suffixOf } from "../src/library/audio-formats";
import { insertUser } from "../src/users/repository";
import { fixtureBytes, fixtures, fixtureTrack } from "./fixtures/files";

/**
 * Helpers shared by the tests. The bindings come from vitest.config.ts, which
 * supplies the two Worker secrets the same way the runtime does.
 */

export const BASE = "https://stratosonic.test";

/** The test environment, including the bindings that are secrets in production. */
export const testEnv = env as Env;

export function encryptionKey(): string {
  const key = testEnv.PASSWORD_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("PASSWORD_ENCRYPTION_KEY is missing from the test bindings");
  }

  return key;
}

/** Creates a user with a known password, the way the bootstrap would. */
export async function seedUser(
  userName: string,
  password: string,
  isAdmin = false,
  email = "",
): Promise<string> {
  const id = newRandomId();
  const now = new Date();

  await insertUser(database(testEnv), {
    id,
    userName,
    name: userName,
    email,
    password: await encryptPassword(encryptionKey(), password),
    isAdmin,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

/** A `<user>` element as the JSON rendering carries it. */
export interface SubsonicUser {
  username: string;
  email?: string;
  scrobblingEnabled: boolean;
  adminRole: boolean;
  settingsRole: boolean;
  downloadRole: boolean;
  uploadRole: boolean;
  playlistRole: boolean;
  coverArtRole: boolean;
  commentRole: boolean;
  podcastRole: boolean;
  streamRole: boolean;
  jukeboxRole: boolean;
  shareRole: boolean;
  videoConversionRole: boolean;
  folder: number[];
}

export interface JsonEnvelope {
  "subsonic-response": {
    status: string;
    version: string;
    type: string;
    serverVersion: string;
    openSubsonic: boolean;
    error?: { code: number; message: string };
    license?: { valid: boolean };
    openSubsonicExtensions?: { name: string; versions: number[] }[];
    user?: SubsonicUser;
    users?: { user: SubsonicUser[] };
  };
}

/* ------------------------------------------------------- library seeds -- */

/**
 * Seeds for the library tables.
 *
 * The read endpoints are tested against rows, not against a scan: a test says
 * what it needs the library to contain and these helpers fill in everything
 * else the way the scanner would - ids derived from the content (ADR-0002),
 * album artist and album name falling back to the R2 key's path segments, the
 * suffix read off the key.
 */

/** The instant every seeded row is created at, unless a test says otherwise. */
export const SEED_TIME = new Date(1_700_000_000_000);

export interface ArtistSeed {
  readonly name: string;
  readonly sortName?: string;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

/** Inserts an artist, with the id the scanner would derive from its name. */
export async function seedArtist(seed: ArtistSeed): Promise<Artist> {
  const row: Artist = {
    id: artistId(seed.name),
    name: seed.name,
    sortName: seed.sortName ?? "",
    createdAt: seed.createdAt ?? SEED_TIME,
    updatedAt: seed.updatedAt ?? seed.createdAt ?? SEED_TIME,
  };

  await database(testEnv).insert(artist).values(row);

  return row;
}

export interface AlbumSeed {
  readonly name: string;
  readonly albumArtist: string;
  readonly year?: number | null;
  readonly genre?: string | null;
  readonly songCount?: number;
  readonly duration?: number;
  readonly size?: number;
  readonly coverKey?: string | null;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

/**
 * Inserts an album. Its id and its artist id are derived the way the scanner
 * derives them, so an album seeded here and an artist seeded above refer to
 * each other without a test having to say so.
 */
export async function seedAlbum(seed: AlbumSeed): Promise<Album> {
  const row: Album = {
    id: albumId(seed.albumArtist, seed.name, seed.year),
    name: seed.name,
    artistId: artistId(seed.albumArtist),
    albumArtist: seed.albumArtist,
    year: seed.year ?? null,
    genre: seed.genre ?? null,
    songCount: seed.songCount ?? 0,
    duration: seed.duration ?? 0,
    size: seed.size ?? 0,
    coverKey: seed.coverKey ?? null,
    createdAt: seed.createdAt ?? SEED_TIME,
    updatedAt: seed.updatedAt ?? seed.createdAt ?? SEED_TIME,
  };

  await database(testEnv).insert(album).values(row);

  return row;
}

export interface TrackSeed {
  readonly r2Key: string;
  readonly title?: string;
  readonly album?: string;
  readonly albumArtist?: string;
  readonly artist?: string;
  readonly trackNumber?: number | null;
  readonly discNumber?: number | null;
  readonly year?: number | null;
  readonly genre?: string | null;
  readonly duration?: number;
  readonly bitRate?: number;
  readonly size?: number;
  readonly etag?: string;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

/**
 * Inserts a track. Everything the seed leaves out is taken from its R2 key, as
 * the scanner takes it when the tags are silent: `artist/album/title.suffix`.
 */
export async function seedTrack(seed: TrackSeed): Promise<Track> {
  const segments = seed.r2Key.split("/");
  const fileName = segments.at(-1) ?? seed.r2Key;
  const albumArtist = seed.albumArtist ?? segments.at(-3) ?? "Unknown Artist";
  const albumName = seed.album ?? segments.at(-2) ?? "Unknown Album";
  const year = seed.year ?? null;

  const row: Track = {
    id: trackId(seed.r2Key),
    r2Key: seed.r2Key,
    title: seed.title ?? fileName.replace(/\.[^.]+$/, ""),
    albumId: albumId(albumArtist, albumName, year),
    artistId: artistId(albumArtist),
    artist: seed.artist ?? albumArtist,
    albumArtist,
    trackNumber: seed.trackNumber ?? null,
    discNumber: seed.discNumber ?? null,
    year,
    duration: seed.duration ?? 1,
    bitRate: seed.bitRate ?? 128,
    size: seed.size ?? 1024,
    suffix: suffixOf(seed.r2Key),
    genre: seed.genre ?? null,
    etag: seed.etag ?? `etag-${trackId(seed.r2Key).slice(0, 8)}`,
    createdAt: seed.createdAt ?? SEED_TIME,
    updatedAt: seed.updatedAt ?? seed.createdAt ?? SEED_TIME,
  };

  await database(testEnv).insert(track).values(row);

  return row;
}

export interface PlaylistSeed {
  /** The R2 key of the `.m3u` this playlist stands for; its id comes from it. */
  readonly r2Key: string;
  readonly name?: string;
  readonly comment?: string;
  readonly ownerId?: string;
  readonly public?: boolean;
  /** The tracks it holds, in order. */
  readonly tracks?: readonly Track[];
  readonly createdAt?: Date;
  readonly changedAt?: Date;
}

/**
 * Inserts a playlist and its entries, in the order given, with the song count
 * and duration recomputed from the tracks as the importer recomputes them.
 */
export async function seedPlaylist(seed: PlaylistSeed): Promise<Playlist> {
  const tracks = seed.tracks ?? [];
  const fileName = seed.r2Key.split("/").at(-1) ?? seed.r2Key;
  const row: Playlist = {
    id: playlistId(seed.r2Key),
    name: seed.name ?? fileName.replace(/\.[^.]+$/, ""),
    comment: seed.comment ?? "",
    ownerId: seed.ownerId ?? "seeded-owner",
    public: seed.public ?? true,
    songCount: tracks.length,
    duration: tracks.reduce((total, entry) => total + entry.duration, 0),
    r2Key: seed.r2Key,
    createdAt: seed.createdAt ?? SEED_TIME,
    changedAt: seed.changedAt ?? seed.createdAt ?? SEED_TIME,
  };

  const db = database(testEnv);
  await db.insert(playlist).values(row);

  if (tracks.length > 0) {
    await db.insert(playlistTrack).values(
      tracks.map((entry, position) => ({
        playlistId: row.id,
        trackId: entry.id,
        position,
      })),
    );
  }

  return row;
}

export interface AnnotationSeed {
  readonly userId: string;
  readonly itemId: string;
  readonly itemType: AnnotationItemType;
  readonly starred?: boolean;
  readonly starredAt?: Date | null;
  readonly rating?: number;
  readonly playCount?: number;
  readonly playDate?: Date | null;
}

/** Inserts one user's state for one item. Starring defaults to now-ish. */
export async function seedAnnotation(seed: AnnotationSeed): Promise<Annotation> {
  const starred = seed.starred ?? true;
  const row: Annotation = {
    userId: seed.userId,
    itemId: seed.itemId,
    itemType: seed.itemType,
    starred,
    starredAt: seed.starredAt ?? (starred ? SEED_TIME : null),
    rating: seed.rating ?? 0,
    playCount: seed.playCount ?? 0,
    playDate: seed.playDate ?? null,
  };

  await database(testEnv).insert(annotation).values(row);

  return row;
}

/* ------------------------------------------------------ fixture seeds -- */

/** An object as it sits in the bucket once seeded. */
export interface SeededObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
}

/**
 * Puts every fixture file in the R2 bucket under the key the manifest gives
 * it, which is where a scan would find them, and answers with what R2 then
 * knows about each one - the etag and size the scanner skips unchanged objects
 * by.
 */
export async function seedFixtureObjects(): Promise<Map<string, SeededObject>> {
  const seeded = new Map<string, SeededObject>();

  for (const { file, r2Key } of [...fixtures.tracks, fixtures.playlist]) {
    seeded.set(r2Key, await seedFixtureObject(file));
  }

  return seeded;
}

/** Puts one fixture file in the bucket, named either by file or by R2 key. */
export async function seedFixtureObject(fileOrKey: string): Promise<SeededObject> {
  const { file, r2Key } =
    fileOrKey === fixtures.playlist.file || fileOrKey === fixtures.playlist.r2Key
      ? fixtures.playlist
      : fixtureTrack(fileOrKey);
  const stored = await testEnv.MUSIC.put(r2Key, fixtureBytes(file));
  if (!stored) {
    throw new Error(`R2 refused the fixture ${file}`);
  }

  return {
    key: r2Key,
    size: stored.size,
    etag: stored.etag,
    uploaded: stored.uploaded,
  };
}

/** The library the fixtures describe: every artist, album and track in them. */
export interface SeededLibrary {
  readonly artists: readonly Artist[];
  readonly albums: readonly Album[];
  readonly tracks: readonly Track[];
}

/**
 * Seeds the rows a completed scan of the fixtures would leave behind, straight
 * into D1: one artist per album artist, one album per (album artist, album,
 * year), and one track per fixture, with each album's song count, duration and
 * size added up from its tracks. Nothing is written to R2 - a test that also
 * needs the bytes calls `seedFixtureObjects`.
 */
export async function seedFixtureLibrary(): Promise<SeededLibrary> {
  const artists: Artist[] = [];
  const albums: Album[] = [];
  const tracks: Track[] = [];

  for (const name of unique(fixtures.tracks.map((fixture) => fixture.tags.albumArtist))) {
    artists.push(await seedArtist({ name }));
  }

  for (const fixture of fixtures.tracks) {
    const { tags } = fixture;
    const id = albumId(tags.albumArtist, tags.album, tags.year);

    if (!albums.some((seeded) => seeded.id === id)) {
      const ofAlbum = fixtures.tracks.filter(
        (candidate) =>
          albumId(candidate.tags.albumArtist, candidate.tags.album, candidate.tags.year) === id,
      );

      albums.push(
        await seedAlbum({
          name: tags.album,
          albumArtist: tags.albumArtist,
          year: tags.year,
          genre: tags.genre,
          songCount: ofAlbum.length,
          duration: ofAlbum.reduce((total, entry) => total + entry.duration.seconds, 0),
          size: ofAlbum.reduce((total, entry) => total + entry.size, 0),
          coverKey: `_covers/${id}.png`,
        }),
      );
    }

    tracks.push(
      await seedTrack({
        r2Key: fixture.r2Key,
        title: tags.title,
        album: tags.album,
        albumArtist: tags.albumArtist,
        artist: tags.artist,
        trackNumber: tags.trackNumber,
        discNumber: tags.discNumber,
        year: tags.year,
        genre: tags.genre,
        duration: fixture.duration.seconds,
        bitRate: fixture.bitRate.kbps,
        size: fixture.size,
      }),
    );
  }

  return { artists, albums, tracks };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
