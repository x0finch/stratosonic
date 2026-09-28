/**
 * `getSimilarSongs` as Navidrome answers it with only its local agent: the
 * reads, and the mix that is made of them. At most two statements.
 *
 * Navidrome's `provider.SimilarSongs` (core/external/provider_similarsongs.go)
 * asks the agents for recommendations and tops the mix up from fallbacks when
 * they fall short. With no external agent, the only agent is the local one
 * (core/agents/local_agent.go), which recommends two things:
 *
 * - **By track** (`GetSimilarSongsByTrack`): random tracks sharing a genre
 *   with the seed, the seed itself excluded, `count` of them at most.
 * - **An artist's top songs** (`GetArtistTopSongs`): the caller's starred or
 *   five-star tracks of that artist, most played first.
 *
 * It recommends nothing by album or by artist, and names no similar artist.
 * What each kind of id then gets, in Navidrome's order of sources:
 *
 * - **A track**: its genre sample; topped up by the fallback of
 *   `similarSongsFallback` — the top songs of the track's artist, drawn in a
 *   weighted random order that favours the most played (`addArtist`'s
 *   weights, `random.WeightedChooser`). That draw can include the seed track
 *   itself, and does in Navidrome.
 * - **An artist**: that same weighted draw of its own top songs; topped up by
 *   `seedMix` over up to five random tracks of the artist.
 * - **An album**: `seedMix` over up to five random tracks of the album.
 * - **A playlist** the caller may see: `seedMix` over up to five random,
 *   distinct tracks of it.
 *
 * `seedMix` merges each seed's genre sample, shuffles, and keeps `count`; when
 * the seeds share no genre with anything, the seeds themselves are the mix.
 * Every merge drops a track already in the mix, and the result never exceeds
 * `count`.
 *
 * Two statements carry all of it: one reads the entity with its seeds —
 * proving it exists, which is what makes an unknown id error 70 — and one
 * reads every candidate the sources could draw on, as a union whose branches
 * keep their own order and limit. The mixing is then done here, in memory.
 *
 * One departure, in distribution only: `seedMix` takes one random sample of
 * the tracks that share a genre with any seed, where Navidrome takes one per
 * seed and merges them. Both keep `count` tracks when that many qualify and
 * every qualifying track otherwise, so what differs is only how likely each
 * track is — and a per-seed sample would read the genre once per seed.
 */

import {
  album,
  annotation,
  artist,
  artistId,
  type EntityId,
  playlist,
  playlistTrack,
  type Track,
  track,
} from "@stratosonic/db";
import { and, eq, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db";
import { type PlaylistViewer, visibleTo } from "../playlists/repository";
import { UNKNOWN_ARTIST, VARIOUS_ARTISTS } from "../scanner/derive";
import { type AnnotationRow, annotationColumns, annotationJoin } from "./annotations";
import { findTrack, toSongView } from "./repository";
import type { SongView } from "./serializers";

/** Navidrome's `maxSeeds`: how many tracks of an album, artist or playlist seed the mix. */
const MAX_SEEDS = 5;

/**
 * How many playlist entries are drawn to find the seeds among: a playlist can
 * hold one track at several positions, so Navidrome's `samplePlaylistTracks`
 * over-fetches four times over and keeps the distinct ones.
 */
const PLAYLIST_DRAW = MAX_SEEDS * 4;

/** The fewest top songs the fallback asks for: `max(count, 20)` in `addArtist`. */
const MIN_TOP_SONGS = 20;

/** `addArtist`'s weight for the entity's own artist; a similar artist would get 0. */
const OWN_ARTIST_WEIGHT = 10;

/**
 * The artists whose top songs are never asked for: Navidrome's
 * `GetArtistTopSongs` answers `ErrNotFound` for `UnknownArtistID` and nothing
 * for `VariousArtistsID` before any agent runs (core/agents/agents.go), so
 * neither has top songs, however the caller starred its tracks.
 */
const NO_TOP_SONGS = new Set([artistId(UNKNOWN_ARTIST), artistId(VARIOUS_ARTISTS)]);

/** The artist whose top songs a mix draws on, or null for one that has none. */
function topSongsArtist(id: string): string | null {
  return NO_TOP_SONGS.has(id) ? null : id;
}

/**
 * The songs similar to what this id names, at most `count` of them; `null`
 * when the id names nothing the caller may see, or a kind that has no
 * similar songs. The caller's annotations decide the top songs, and their
 * account decides which playlists they may name.
 */
export async function similarSongs(
  db: Database,
  caller: PlaylistViewer,
  entity: EntityId,
  count: number,
): Promise<SongView[] | null> {
  switch (entity.type) {
    case "track": {
      const seed = await findTrack(db, entity.id, caller.id);
      if (seed === null) {
        return null;
      }

      const candidates = await readCandidates(
        db,
        caller.id,
        count,
        [seed],
        topSongsArtist(seed.artistId),
      );

      return topUp(shuffled(candidates.genre), count, [
        () => weightedTopSongs(candidates.top, count),
      ]);
    }
    case "artist": {
      const seeds = await readArtistSeeds(db, caller.id, entity.id);
      if (seeds === null) {
        return null;
      }

      const candidates = await readCandidates(
        db,
        caller.id,
        count,
        seeds,
        topSongsArtist(entity.id),
      );

      return topUp([], count, [
        () => weightedTopSongs(candidates.top, count),
        () => seedMix(seeds, candidates.genre, count),
      ]);
    }
    case "album":
    case "playlist": {
      const seeds =
        entity.type === "album"
          ? await readAlbumSeeds(db, caller.id, entity.id)
          : await readPlaylistSeeds(db, caller, entity.id);
      if (seeds === null) {
        return null;
      }

      const candidates = await readCandidates(db, caller.id, count, seeds, null);

      return topUp([], count, [() => seedMix(seeds, candidates.genre, count)]);
    }
    default:
      return null;
  }
}

/* -------------------------------------------------------------- mixing -- */

/**
 * Navidrome's `topUp`: the mix so far, then each source in turn while the mix
 * is short of `count`, dropping what is already in it, trimmed to `count`.
 */
function topUp(
  start: readonly SongView[],
  count: number,
  sources: readonly (() => readonly SongView[])[],
): SongView[] {
  let mix = distinct(start);

  for (const more of sources) {
    if (mix.length >= count) {
      break;
    }
    mix = distinct([...mix, ...more()]);
  }

  return mix.slice(0, count);
}

/**
 * Navidrome's `seedMix`: the seeds' genre samples, shuffled and trimmed to
 * `count`, or the seeds themselves when nothing shares their genres — and
 * nothing at all without a seed.
 */
function seedMix(
  seeds: readonly SongView[],
  genreSample: readonly SongView[],
  count: number,
): SongView[] {
  if (seeds.length === 0) {
    return [];
  }

  const matched = distinct(genreSample);

  return shuffled(matched.length > 0 ? matched : seeds).slice(0, count);
}

/**
 * The top songs of the entity's own artist, drawn without replacement in a
 * weighted random order, until `count` are drawn or none are left.
 *
 * The weights are `addArtist`'s: the most played song weighs
 * `topCount * (4 + 10)` and each one after it 4 less, so the ranking tilts
 * the draw without deciding it (core/external/provider_similarsongs.go,
 * utils/random/weighted_random_chooser.go).
 */
function weightedTopSongs(topSongs: readonly SongView[], count: number): SongView[] {
  const topCount = Math.max(count, MIN_TOP_SONGS);
  const pool = topSongs.map((song, index) => ({
    song,
    weight: topCount * (4 + OWN_ARTIST_WEIGHT) - 4 * index,
  }));
  const drawn: SongView[] = [];

  while (drawn.length < count && pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    let pick = Math.floor(Math.random() * total);
    let index = 0;
    for (; index < pool.length - 1; index += 1) {
      pick -= pool[index]?.weight ?? 0;
      if (pick < 0) {
        break;
      }
    }

    const [entry] = pool.splice(index, 1);
    if (entry) {
      drawn.push(entry.song);
    }
  }

  return drawn;
}

/** The songs in order, each track once, where it first appears. */
function distinct(songs: readonly SongView[]): SongView[] {
  const seen = new Set<string>();

  return songs.filter((song) => {
    if (seen.has(song.id)) {
      return false;
    }
    seen.add(song.id);
    return true;
  });
}

/** A uniformly random permutation (Fisher–Yates), as Go's `rand.Shuffle` makes one. */
function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other] as T, result[index] as T];
  }

  return result;
}

/* --------------------------------------------------------------- seeds -- */

/** A seed row: a track joined from its parent, or none when the parent has no track. */
type SeedRow = {
  track: Track | null;
  albumName: string | null;
  albumCoverKey: string | null;
} & AnnotationRow;

/** The tracks among seed rows, as songs; a parent with no track yields none. */
function seedsOf(rows: readonly SeedRow[]): SongView[] {
  return rows.flatMap(({ track: row, ...rest }) =>
    row === null ? [] : [toSongView({ ...rest, track: row })],
  );
}

/**
 * Up to five random tracks of an album, or null when there is no such album.
 * Reading from the album and joining its tracks left is what tells the two
 * apart in one statement: an album with no tracks is one row with no track.
 */
async function readAlbumSeeds(
  db: Database,
  userId: string,
  albumId: string,
): Promise<SongView[] | null> {
  const rows = await db
    .select({ track, albumName: album.name, albumCoverKey: album.coverKey, ...annotationColumns })
    .from(album)
    .leftJoin(track, eq(track.albumId, album.id))
    .leftJoin(annotation, annotationJoin(userId, "track", track.id))
    .where(eq(album.id, albumId))
    .orderBy(sql`random()`)
    .limit(MAX_SEEDS);

  return rows.length === 0 ? null : seedsOf(rows);
}

/**
 * Up to five random tracks of an artist, or null when there is no such
 * artist. Navidrome samples the tracks the artist is credited on as artist or
 * album artist (`sampleArtistTracks`); a track's artist id here is its album
 * artist's, which is what an artist is in this library (CONTEXT.md).
 */
async function readArtistSeeds(
  db: Database,
  userId: string,
  id: string,
): Promise<SongView[] | null> {
  const rows = await db
    .select({ track, albumName: album.name, albumCoverKey: album.coverKey, ...annotationColumns })
    .from(artist)
    .leftJoin(track, eq(track.artistId, artist.id))
    .leftJoin(album, eq(album.id, track.albumId))
    .leftJoin(annotation, annotationJoin(userId, "track", track.id))
    .where(eq(artist.id, id))
    .orderBy(sql`random()`)
    .limit(MAX_SEEDS);

  return rows.length === 0 ? null : seedsOf(rows);
}

/**
 * Up to five random, distinct tracks of a playlist the caller may see, or
 * null when there is none. Entries whose track has gone sort last, so they
 * take no seed's place, but the playlist's own row still proves it exists.
 */
async function readPlaylistSeeds(
  db: Database,
  caller: PlaylistViewer,
  playlistId: string,
): Promise<SongView[] | null> {
  const rows = await db
    .select({ track, albumName: album.name, albumCoverKey: album.coverKey, ...annotationColumns })
    .from(playlist)
    .leftJoin(playlistTrack, eq(playlistTrack.playlistId, playlist.id))
    .leftJoin(track, eq(track.id, playlistTrack.trackId))
    .leftJoin(album, eq(album.id, track.albumId))
    .leftJoin(annotation, annotationJoin(caller.id, "track", track.id))
    .where(and(eq(playlist.id, playlistId), visibleTo(caller)))
    .orderBy(sql`${track.id} is null`, sql`random()`)
    .limit(PLAYLIST_DRAW);

  return rows.length === 0 ? null : distinct(seedsOf(rows)).slice(0, MAX_SEEDS);
}

/* ---------------------------------------------------------- candidates -- */

/** What the sources can draw on: the genre sample, and the artist's top songs by rank. */
interface Candidates {
  readonly genre: readonly SongView[];
  readonly top: readonly SongView[];
}

/** Which branch of the candidate union a row came from. */
const GENRE_BRANCH = 0;
const TOP_BRANCH = 1;

/**
 * Every candidate the mix can draw on, in one statement: a union of the genre
 * sample of these seeds and the top songs of this artist, each branch with its
 * own order and limit, joined back to the tracks for what a `<song>` needs.
 * No statement at all when neither branch has anything to ask.
 */
async function readCandidates(
  db: Database,
  userId: string,
  count: number,
  seeds: readonly SongView[],
  topArtistId: string | null,
): Promise<Candidates> {
  const branches: SQL[] = [];

  const genre = genreCondition(seeds);
  if (genre !== null) {
    // Navidrome's local agent asks for `count + 1` random tracks and drops the
    // seed; excluding the seed in the query and asking for `count` is the
    // same sample. For several seeds, see the module comment.
    branches.push(sql`select * from (select track.id as id, ${GENRE_BRANCH} as branch, 0 as rank
      from track where ${genre} order by random() limit ${count})`);
  }

  if (topArtistId !== null) {
    // The local agent's `GetArtistTopSongs`: the artist's tracks the caller
    // starred or rated 5, `playCount` descending, `max(count, 20)` of them.
    // The id breaks a tie, which Navidrome leaves to the database.
    const topCount = Math.max(count, MIN_TOP_SONGS);
    branches.push(sql`select * from (select track.id as id, ${TOP_BRANCH} as branch,
        row_number() over (order by annotation.play_count desc, track.id) as rank
      from track join annotation on annotation.user_id = ${userId}
        and annotation.item_type = 'track' and annotation.item_id = track.id
      where track.artist_id = ${topArtistId}
        and (annotation.starred = 1 or annotation.rating = 5)
      order by annotation.play_count desc, track.id limit ${topCount})`);
  }

  if (branches.length === 0) {
    return { genre: [], top: [] };
  }

  const rows = await db
    .select({
      track,
      albumName: album.name,
      albumCoverKey: album.coverKey,
      ...annotationColumns,
      branch: sql<number>`candidate.branch`,
      rank: sql<number>`candidate.rank`,
    })
    .from(sql`(${sql.join(branches, sql` union all `)}) as candidate`)
    .innerJoin(track, sql`${track.id} = candidate.id`)
    .leftJoin(album, eq(album.id, track.albumId))
    .leftJoin(annotation, annotationJoin(userId, "track", track.id));

  const inBranch = (branch: number) =>
    rows
      .filter((row) => row.branch === branch)
      .sort((a, b) => a.rank - b.rank)
      .map(({ branch: _branch, rank: _rank, ...row }) => toSongView(row));

  return { genre: inBranch(GENRE_BRANCH), top: inBranch(TOP_BRANCH) };
}

/**
 * The tracks that share a genre with a seed other than themselves, or null
 * when no seed has a genre — the local agent returns nothing for a seed with
 * none. A genre two seeds carry admits every track of it, since each seed's
 * sample may hold the other; a genre only one seed carries admits every track
 * of it but that seed.
 *
 * Genres match without regard to case, as Navidrome's do: its genre ids hash
 * the lowercased value (`id.NewTagID`, model/id/id.go).
 */
function genreCondition(seeds: readonly SongView[]): SQL | null {
  const byGenre = new Map<string, { genre: string; seedIds: string[] }>();

  for (const seed of seeds) {
    if (!seed.genre) {
      continue;
    }
    const key = seed.genre.toLowerCase();
    const entry = byGenre.get(key) ?? { genre: seed.genre, seedIds: [] };
    entry.seedIds.push(seed.id);
    byGenre.set(key, entry);
  }

  const conditions = [...byGenre.values()].map(({ genre, seedIds }) =>
    seedIds.length === 1
      ? sql`(lower(track.genre) = lower(${genre}) and track.id <> ${seedIds[0]})`
      : sql`lower(track.genre) = lower(${genre})`,
  );

  return conditions.length === 0 ? null : sql`(${sql.join(conditions, sql` or `)})`;
}
