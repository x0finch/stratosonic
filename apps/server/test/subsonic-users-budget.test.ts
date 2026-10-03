import { beforeAll, describe, expect, it } from "vitest";
import { encryptPassword } from "../src/auth/crypto";
import { database } from "../src/db";
import { insertUser } from "../src/users/repository";
import {
  type CookieJar,
  cost,
  type RecordedStatement,
  seedConsoleUser,
  shape,
  signIn,
} from "./console-auth-support";
import { subsonicUsersHarness } from "./subsonic-users-support";
import { encryptionKey, testEnv } from "./support";

/**
 * What the Subsonic-user routes cost D1 on #82's reference library ("Free-tier
 * budget"): 5 Subsonic users and 20 playlists, here 4 each of 25 entries,
 * measured with `countingD1` and `cost()` as the budget table is. The user
 * deleted also has 100 annotations, a playback session, a play queue and 2
 * bookmarks, which cascade with them. The session check is left out, as the
 * table leaves it out: a write's `requireFreshSession` reads the session and
 * its console user, and a read's `requireSession` costs nothing within the
 * cookie cache.
 */

const ORIGIN = "https://subsonic-users-budget.stratosonic.test";
const harness = subsonicUsersHarness(ORIGIN);

const PLAYLISTS_PER_USER = 4;
const ENTRIES_PER_PLAYLIST = 25;
const ANNOTATIONS = 100;

let owner: CookieJar;
const userIds: string[] = [];

/** `n` from 0 to `count - 1`, for an `insert ... select` to count rows out with. */
function counted(count: number): string {
  return `with recursive n(i) as (select 0 union all select i + 1 from n where i < ${count - 1})`;
}

beforeAll(async () => {
  await seedConsoleUser("owner", "budget");
  owner = (await signIn(harness.send, ORIGIN, "owner", "budget")).jar;

  // Ids of a fixed order, not `newRandomId`'s: D1 counts the extra index
  // entry a lookup by owner reads past the last match, which there is not
  // when the owner's id sorts last, so random ids would move the counts.
  const at = 1_700_000_000_000;
  const password = await encryptPassword(encryptionKey(), "sesame");
  for (const [index, name] of ["admin", "ann", "ben", "cat", "dan"].entries()) {
    const id = `user-${index}`;
    await insertUser(database(testEnv), {
      id,
      userName: name,
      name,
      password,
      isAdmin: index === 0,
      createdAt: new Date(at),
      updatedAt: new Date(at),
    });
    userIds.push(id);
  }

  const statements = userIds.map((userId, user) =>
    testEnv.DB.prepare(
      `${counted(PLAYLISTS_PER_USER)} insert into playlist
         (id, name, owner_id, song_count, duration, r2_key, created_at, changed_at)
       select 'pl${user}-' || i, 'Playlist ${user}-' || i, ?1, ${ENTRIES_PER_PLAYLIST}, 6012.5,
         'playlists/${user}-' || i || '.m3u', ${at}, ${at} from n`,
    ).bind(userId),
  );
  const entries = PLAYLISTS_PER_USER * userIds.length * ENTRIES_PER_PLAYLIST;
  const ann = userIds[1];
  await testEnv.DB.batch([
    ...statements,
    testEnv.DB.prepare(
      `${counted(entries)} insert into playlist_track (playlist_id, track_id, position)
       select p.id, 'tr' || (n.i % ${ENTRIES_PER_PLAYLIST}), n.i % ${ENTRIES_PER_PLAYLIST}
       from n join (select id, row_number() over (order by id) - 1 as k from playlist) p
         on p.k = n.i / ${ENTRIES_PER_PLAYLIST}`,
    ),
    testEnv.DB.prepare(
      `${counted(ANNOTATIONS)} insert into annotation (user_id, item_id, item_type, play_count)
       select ?1, 'tr' || i, 'track', 1 from n`,
    ).bind(ann),
    testEnv.DB.prepare(
      `insert into now_playing (user_id, track_id, started_at) values (?1, 'tr0', ${at})`,
    ).bind(ann),
    testEnv.DB.prepare(
      `insert into play_queue (user_id, track_ids, changed_at) values (?1, '["tr0"]', ${at})`,
    ).bind(ann),
    testEnv.DB.prepare(
      `${counted(2)} insert into bookmark (user_id, track_id, created_at, changed_at)
       select ?1, 'tr' || i, ${at}, ${at} from n`,
    ).bind(ann),
  ]);
  for (let user = 0; user < userIds.length; user++) {
    for (let index = 0; index < PLAYLISTS_PER_USER; index++) {
      await testEnv.MUSIC.put(`playlists/${user}-${index}.m3u`, "#EXTM3U\n");
    }
  }
});

/** What a request sent to D1 past the console session's own check. */
async function measured(method: string, path: string, body?: unknown) {
  harness.d1.reset();
  const response = await harness.call(owner, method, path, body);
  const statements = [...harness.d1.statements];
  const session = statements.filter((statement) =>
    ["select session", "select user"].includes(shape(statement)),
  );
  return {
    status: response.status,
    session: session.map(shape),
    route: statements.filter((statement) => !session.includes(statement)),
  };
}

/** Each statement as `[<verb> <table>, rows read, rows written]`. */
function rows(statements: readonly RecordedStatement[]) {
  return statements.map((statement) => [
    shape(statement),
    statement.rowsRead,
    statement.rowsWritten,
  ]);
}

describe("the Subsonic users' budget on the reference library", () => {
  it("GET /api/subsonic-users: one statement, reading the users", async () => {
    const { status, route } = await measured("GET", "/subsonic-users");

    expect(status).toBe(200);
    // One select of the users (`shape` names the playlist subquery's table,
    // its first `from`). Each of the five users and the sorter again for the
    // order, 10, and each user's 4 entries in `playlist_owner_id_idx` and the
    // one past them, but for the user whose id sorts last, 24.
    expect(route).toHaveLength(1);
    expect(route[0]?.sql).toMatch(/ from "subsonic_user" order by /);
    expect(cost(route)).toEqual({ statements: 1, roundTrips: 1, rowsRead: 34, rowsWritten: 0 });
  });

  it("POST /api/subsonic-users: one batch past the session, the user and their libraries", async () => {
    const { status, session, route } = await measured("POST", "/subsonic-users", {
      username: "eve",
      password: "pw",
    });

    expect(status).toBe(201);
    expect(session).toEqual(["select session", "select user"]);
    // The admin check stops at the first admin; the row, its primary key and
    // its `lower(user_name)` index entry are written. Then the default
    // library, library 1, is granted: the library row and the new user read,
    // and the grant's row, its primary key and its `library_id` index entry
    // written (#84, "Per-user access").
    expect(rows(route)).toEqual([
      ["insert subsonic_user", 3, 3],
      ["insert user_library", 3, 3],
    ]);
    expect(cost(route).roundTrips).toBe(1);
  });

  it("PATCH /api/subsonic-users/:id: one guarded statement, and a read on refusal", async () => {
    // A promotion also grants every library, in the same batch: here library
    // 1, which this user, seeded without libraries, did not have yet.
    const id = userIds[2] ?? "";
    const cases = [
      // The row by primary key, and the answer's playlist count: the user's 4
      // entries in `playlist_owner_id_idx` and the one past them. A rename
      // rewrites the row's index entry too.
      [{ username: "benedict" }, [["update subsonic_user", 7, 2]]],
      [
        { isAdmin: true },
        [
          ["update subsonic_user", 7, 1],
          ["insert user_library", 3, 3],
        ],
      ],
      // A demotion also looks for another admin, and finds one at once.
      [{ isAdmin: false }, [["update subsonic_user", 8, 1]]],
      [{ username: "ben", isAdmin: false }, [["update subsonic_user", 7, 2]]],
    ] as const;
    for (const [body, expected] of cases) {
      const { status, route } = await measured("PATCH", `/subsonic-users/${id}`, body);
      expect(status).toBe(200);
      expect(rows(route)).toEqual(expected);
    }

    // Demoting the only admin looks at every user for another and writes
    // nothing; a second read then tells last_admin from not_found.
    const { status, route } = await measured("PATCH", `/subsonic-users/${userIds[0]}`, {
      isAdmin: false,
    });
    expect(status).toBe(409);
    expect(rows(route)).toEqual([
      ["update subsonic_user", 8, 0],
      ["select subsonic_user", 1, 0],
    ]);
    expect(cost(route).roundTrips).toBe(2);
  });

  it("PUT /api/subsonic-users/:id/password: one statement", async () => {
    const { status, route } = await measured("PUT", `/subsonic-users/${userIds[3]}/password`, {
      password: "new",
    });

    expect(status).toBe(200);
    expect(rows(route)).toEqual([["update subsonic_user", 2, 1]]);
  });

  it("DELETE /api/subsonic-users/:id: a check, one R2 call and one batch", async () => {
    // Refused: the check alone, in one round trip, and no R2 call.
    const deletes = harness.r2Deletes.length;
    const refused = await measured("DELETE", `/subsonic-users/${userIds[0]}`, {});
    expect(refused.status).toBe(409);
    expect(rows(refused.route)).toEqual([
      ["select subsonic_user", 7, 0],
      ["select playlist", 5, 0],
    ]);
    expect(cost(refused.route).roundTrips).toBe(1);
    expect(harness.r2Deletes.length).toBe(deletes);

    const { status, route } = await measured("DELETE", `/subsonic-users/${userIds[1]}`, {});

    expect(status).toBe(200);
    expect(harness.r2Deletes.slice(deletes)).toHaveLength(1);
    expect(rows(route)).toEqual([
      // The check: the user by key, and their playlists by owner.
      ["select subsonic_user", 2, 0],
      ["select playlist", 5, 0],
      // The user and, by cascade, their 100 annotations, playback session,
      // play queue and 2 bookmarks.
      ["delete subsonic_user", 312, 105],
      // Their 4 playlists and, by cascade, their 100 entries.
      ["delete playlist", 317, 104],
    ]);
    expect(cost(route)).toEqual({ statements: 4, roundTrips: 2, rowsRead: 636, rowsWritten: 209 });
  });
});
