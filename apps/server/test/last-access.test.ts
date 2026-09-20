import { SELF } from "cloudflare:test";
import { user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { subsonicToken } from "../src/auth/crypto";
import { database } from "../src/db";
import { BASE, seedUser, testEnv } from "./support";

const USER = "walker";
const PASSWORD = "sesame";
const SALT = "c19b2d";

let userId = "";
let query = "";

async function ping(): Promise<void> {
  const response = await SELF.fetch(`${BASE}/rest/ping?${query}`);

  expect(response.status).toBe(200);
}

async function lastAccessAt(): Promise<Date | null> {
  const rows = await database(testEnv).select().from(user).where(eq(user.id, userId));

  return rows[0]?.lastAccessAt ?? null;
}

beforeAll(async () => {
  userId = await seedUser(USER, PASSWORD);
  query = new URLSearchParams({
    u: USER,
    t: await subsonicToken(PASSWORD, SALT),
    s: SALT,
    v: "1.16.1",
    c: "Substreamer",
  }).toString();
});

describe("last access", () => {
  it("is unset until the user shows up", async () => {
    expect(await lastAccessAt()).toBeNull();
  });

  it("is recorded on the first authenticated request", async () => {
    await ping();

    expect(await lastAccessAt()).toBeInstanceOf(Date);
  });

  it("is not written again on the requests that follow", async () => {
    const first = await lastAccessAt();

    for (let request = 0; request < 5; request++) {
      await ping();
    }

    expect(await lastAccessAt()).toEqual(first);
  });

  it("is not written for a request that fails to authenticate", async () => {
    const other = await seedUser("stranger", PASSWORD);

    await SELF.fetch(`${BASE}/rest/ping?u=stranger&p=wrong&v=1.16.1&c=Substreamer`);

    const rows = await database(testEnv).select().from(user).where(eq(user.id, other));
    expect(rows[0]?.lastAccessAt).toBeNull();
  });
});
