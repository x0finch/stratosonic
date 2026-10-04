import {
  type Library,
  library,
  playlist,
  playlistId,
  playlistTrack,
  property,
  subsonicUser,
  userLibrary,
} from "@stratosonic/db";
import { asc, eq } from "drizzle-orm";
import { expect, type MockInstance, vi } from "vitest";
import { database } from "../src/db";
import { cost } from "./console-auth-support";
import type { FakeS3 } from "./fake-s3";
import { type FilesHarness, type FilesHarnessOptions, filesHarness } from "./files-support";
import { SEED_TIME, testEnv } from "./support";

/**
 * The console's Libraries API under test (#84, "Libraries API"): the
 * Worker's app over a D1 binding that records every statement and a scan
 * driver that records every call (test/files-support.ts), with every answer's
 * text and every console line kept, so a test can show that no secret is ever
 * answered or logged.
 */

/** A library as `GET /api/libraries` answers it. */
export interface LibraryView {
  id: number;
  name: string;
  kind: "r2-binding" | "s3";
  accountId: string | null;
  bucket: string | null;
  accessKeyIdHint: string | null;
  writable: boolean;
  defaultNewUsers: boolean;
  state: "active" | "removing";
  lastScanStartedAt: string | null;
  lastScanAt: string | null;
  lastScanError: string | null;
  counts: {
    artists: number;
    albums: number;
    tracks: number;
    sizeBytes: number;
    durationSec: number;
  };
}

export interface LibrariesHarness extends FilesHarness {
  /** The text of every answer `call` received, in order. */
  readonly answers: string[];
  /** Every line the Worker wrote to the console, from `captureConsole` on. */
  readonly lines: string[];
  /** Starts recording the console's lines; stop with the returned spies' `mockRestore`. */
  captureConsole(): MockInstance[];
}

export function librariesHarness(
  origin: string,
  options: FilesHarnessOptions = {},
): LibrariesHarness {
  const files = filesHarness(origin, options);
  const answers: string[] = [];
  const lines: string[] = [];

  return {
    ...files,
    answers,
    lines,
    call: async (jar, method, path, body, headers) => {
      const response = await files.call(jar, method, path, body, headers);
      answers.push(await response.clone().text());
      return response;
    },
    captureConsole: () =>
      (["log", "info", "warn", "error", "debug"] as const).map((method) =>
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          lines.push(args.map((arg) => describe(arg)).join(" "));
        }),
      ),
  };
}

/** A logged value as text, an error's message, stack and causes included. */
function describe(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message} ${value.stack ?? ""} ${describe(value.cause)}`;
  }
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

/** Every row a libraries write could change, in a stable order. */
export async function tables() {
  const db = database(testEnv);
  return {
    libraries: await db.select().from(library).orderBy(asc(library.id)),
    grants: await db
      .select()
      .from(userLibrary)
      .orderBy(asc(userLibrary.userId), asc(userLibrary.libraryId)),
    playlists: await db.select().from(playlist).orderBy(asc(playlist.id)),
    entries: await db
      .select()
      .from(playlistTrack)
      .orderBy(asc(playlistTrack.playlistId), asc(playlistTrack.position)),
    properties: await db.select().from(property).orderBy(asc(property.id)),
    users: await db.select().from(subsonicUser).orderBy(asc(subsonicUser.id)),
  };
}

/**
 * That a request is refused with this status and body, and changes nothing:
 * no D1 row written, no call to the fake S3 endpoint, none to the scan
 * driver.
 */
export async function expectRefusal(
  harness: LibrariesHarness,
  fake: FakeS3,
  request: () => Response | Promise<Response>,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  const before = await tables();
  const s3Calls = fake.calls.length;
  const driverCalls = harness.driverCalls.length;
  harness.d1.reset();

  const response = await request();

  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(body);
  expect(cost(harness.d1.statements).rowsWritten).toBe(0);
  expect(fake.calls.length).toBe(s3Calls);
  expect(harness.driverCalls.length).toBe(driverCalls);
  expect(await tables()).toEqual(before);
}

/** A library's row. */
export async function libraryRow(id: number): Promise<Library | undefined> {
  const [row] = await database(testEnv).select().from(library).where(eq(library.id, id));
  return row;
}

/** The libraries a user's rows grant, by id. */
export async function grantsOf(userId: string): Promise<number[]> {
  const rows = await database(testEnv)
    .select({ libraryId: userLibrary.libraryId })
    .from(userLibrary)
    .where(eq(userLibrary.userId, userId))
    .orderBy(asc(userLibrary.libraryId));
  return rows.map((row) => row.libraryId);
}

/** Inserts a playlist row whose `.m3u` is in library `libraryId`, owned by `ownerId`. */
export async function seedLibraryPlaylist(
  libraryId: number,
  r2Key: string,
  ownerId: string,
): Promise<string> {
  const id = playlistId(libraryId, r2Key);
  await database(testEnv).insert(playlist).values({
    id,
    name: r2Key,
    comment: "",
    ownerId,
    public: true,
    songCount: 0,
    duration: 0,
    r2Key,
    createdAt: SEED_TIME,
    changedAt: SEED_TIME,
    libraryId,
  });
  return id;
}
