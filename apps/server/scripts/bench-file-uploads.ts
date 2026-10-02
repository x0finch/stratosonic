/**
 * CPU per request of the console's upload routes (#83, "Signing" and
 * "Free-tier budget"; #132).
 *
 *   pnpm --filter @stratosonic/server bench:file-uploads
 *
 * Not part of the test suite or CI: its numbers depend on the machine.
 * Re-run it when aws4fetch, files/sign.ts, the upload routes or `SIGN_BATCH`
 * change, and compare with the table in the PR that made the change.
 *
 * It runs in Node for the reason bench-console-auth.ts gives (workerd does
 * not advance its clocks while JavaScript runs), over the same D1 stand-in,
 * and reports the time spent outside it. The bucket's `head()` is an
 * in-memory map and the scan driver a stub that answers at once: on Workers
 * both are I/O the Worker only waits for. Node's `crypto.subtle` hops to a
 * thread pool for every HMAC and digest, which workerd's BoringSSL does not,
 * so the signing rows overstate the edge. Read p50 as the estimate, and
 * confirm with Workers Observability (`cpuTime`) on a deployment.
 *
 * Every credential here is made up.
 */

import { Hono } from "hono";
import { createApiApp } from "../src/api/app";
import { createConsoleUser } from "../src/console-auth/credentials";
import { database } from "../src/db";
import type { Env } from "../src/env";
import type { UploadsConfig } from "../src/files/config";
import { presignUpload } from "../src/files/sign";
import { apiRequest, bench, cookieHeader, expecting, migratedD1, report } from "./bench-support";

const PASSPHRASE = "bench-password-encryption-key";
const ORIGIN = "https://stratosonic.bench";

const UPLOADS: UploadsConfig = {
  accessKeyId: "bench-access-key-id",
  secretAccessKey: "bench-secret-access-key-not-real",
  accountId: "0123456789abcdef0123456789abcdef",
  bucket: "navidrome",
};

/** The bucket's objects, by key, as `head()` answers them. */
const stored = new Map<string, Pick<R2Object, "key" | "size" | "uploaded">>();
const MUSIC = {
  head: async (key: string) => stored.get(key) ?? null,
} as unknown as R2Bucket;

/**
 * A scan driver that answers at once: `touch`, which a completion calls,
 * schedules a pass after the quiet window, as an idle driver does.
 */
const SCAN_DRIVER = {
  idFromName: () => ({}),
  get: () => ({
    start: async () => "started",
    touch: async (at: number) => ({
      scheduledAt: new Date(at + 120_000).toISOString(),
      afterCurrentPass: false,
    }),
  }),
} as unknown as Env["SCAN_DRIVER"];

const { DB } = migratedD1();
const env = {
  DB,
  MUSIC,
  SCAN_DRIVER,
  PASSWORD_ENCRYPTION_KEY: PASSPHRASE,
  R2_ACCESS_KEY_ID: UPLOADS.accessKeyId,
  R2_SECRET_ACCESS_KEY: UPLOADS.secretAccessKey,
  CF_ACCOUNT_ID: UPLOADS.accountId,
  R2_BUCKET_NAME: UPLOADS.bucket,
} as unknown as Env;

const app = new Hono<{ Bindings: Env }>().route("/api", createApiApp());
const send = (request: Request) => app.request(request, undefined, env);

await createConsoleUser(database(env), PASSPHRASE, {
  username: "Alice",
  password: "wonderland",
  role: "owner",
});
const signedIn = await send(
  apiRequest(ORIGIN, "/api/auth/sign-in/username", {
    body: { username: "alice", password: "wonderland" },
  }),
);
if (signedIn.status !== 200) throw new Error(`sign-in answered ${signedIn.status}`);
const cookie = cookieHeader(signedIn);

/* ------------------------------------------------------------- signing -- */

const ONE = { key: "Artist/Album/01 Title.flac", size: 41_234_567, contentType: "audio/flac" };

await bench(
  "presignUpload, signing key cached (warm client)",
  5000,
  async () => () => presignUpload(UPLOADS, { ...ONE, replace: false }),
);

// A new token each run: the client is rebuilt and derives its signing key,
// as the first upload of an isolate (or of a UTC day) does.
let rotations = 0;
await bench("presignUpload, signing key derived (first of an isolate)", 2000, async () => {
  const config = { ...UPLOADS, secretAccessKey: `${UPLOADS.secretAccessKey}-${rotations++}` };
  return () => presignUpload(config, { ...ONE, replace: false });
});

/* -------------------------------------------------------------- routes -- */

function files(n: number) {
  return Array.from({ length: n }, (_, index) => ({
    key: `Artist/Album/${String(index + 1).padStart(2, "0")} Title.flac`,
    size: 41_234_567,
  }));
}

for (const [n, runs] of [
  [1, 1000],
  [3, 1000],
  [10, 1000],
] as const) {
  const body = { files: files(n) };
  await bench(
    `POST /api/files/uploads, ${n} new file${n === 1 ? "" : "s"}`,
    runs,
    async () => () =>
      expecting(200, send(apiRequest(ORIGIN, "/api/files/uploads", { body, cookie }))),
  );
}

// Every key exists: 10 head() calls and no signature.
for (const file of files(10)) {
  stored.set(file.key, { key: file.key, size: file.size, uploaded: new Date() });
}
await bench(
  "POST /api/files/uploads, 10 files that exist (no signature)",
  500,
  async () => () =>
    expecting(
      200,
      send(apiRequest(ORIGIN, "/api/files/uploads", { body: { files: files(10) }, cookie })),
    ),
);
await bench(
  "POST /api/files/uploads, 10 Replace",
  500,
  async () => () =>
    expecting(
      200,
      send(
        apiRequest(ORIGIN, "/api/files/uploads", {
          body: { files: files(10).map((file) => ({ ...file, overwrite: true })) },
          cookie,
        }),
      ),
    ),
);

/**
 * A completion, which must reach the driver: `scan: null` would mean the
 * bench timed the logged-failure path instead.
 */
async function complete(keys: readonly string[]): Promise<void> {
  const response = await send(
    apiRequest(ORIGIN, "/api/files/uploads/complete", { body: { keys }, cookie }),
  );
  const body = (await response.json()) as { scan?: unknown };
  if (response.status !== 200 || body.scan === null || body.scan === undefined) {
    throw new Error(`a completion answered ${response.status} ${JSON.stringify(body)}`);
  }
}

const keys = files(10).map((file) => file.key);
await bench(
  "POST /api/files/uploads/complete, 1 key",
  1000,
  async () => () => complete(keys.slice(0, 1)),
);
await bench("POST /api/files/uploads/complete, 10 keys", 1000, async () => () => complete(keys));

report();
