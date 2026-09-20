import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE, type JsonEnvelope, seedUser } from "./support";

/**
 * `getUsers` against the Worker: admin-only, and it lists the caller — the
 * bootstrap admin (`admin` / `sesame`, from the test bindings) here.
 */

const ADMIN = "admin";
const LISTENER = "listener";
const PASSWORD = "sesame";

function query(userName: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    u: userName,
    p: PASSWORD,
    v: "1.16.1",
    c: "Substreamer",
    ...extra,
  }).toString();
}

async function getUsers(userName: string): Promise<JsonEnvelope["subsonic-response"]> {
  const response = await SELF.fetch(`${BASE}/rest/getUsers?${query(userName)}&f=json`);
  const body = (await response.json()) as JsonEnvelope;

  return body["subsonic-response"];
}

beforeAll(async () => {
  // The bootstrap only creates the admin while the user table is empty, so the
  // first request has to reach the Worker before anything else is seeded.
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedUser(LISTENER, PASSWORD);
});

describe("getUsers", () => {
  it.each(["/rest/getUsers", "/rest/getUsers.view"])(
    "lists the admin caller on %s",
    async (path) => {
      const xml = await (await SELF.fetch(`${BASE}${path}?${query(ADMIN)}`)).text();

      expect(xml).toContain('status="ok"');
      expect(xml).toContain('<users><user username="admin"');
      expect(xml).toContain("<folder>1</folder>");
    },
  );

  it("returns the caller as the single user, in JSON", async () => {
    const body = await getUsers(ADMIN);

    expect(body.status).toBe("ok");
    expect(body.users?.user).toHaveLength(1);
    expect(body.users?.user[0]).toMatchObject({
      username: ADMIN,
      adminRole: true,
      coverArtRole: true,
      streamRole: true,
      folder: [1],
    });
  });

  it("does not disclose the other accounts on the server", async () => {
    const body = await getUsers(ADMIN);

    expect(body.users?.user.map((user) => user.username)).toEqual([ADMIN]);
  });

  it("refuses a user who is not an admin with error 50", async () => {
    const body = await getUsers(LISTENER);

    expect(body).toMatchObject({
      status: "failed",
      error: { code: 50, message: "User is not authorized for the given operation" },
    });
    expect(body.users).toBeUndefined();
  });

  it("checks the credentials before the admin flag", async () => {
    const response = await SELF.fetch(
      `${BASE}/rest/getUsers?${query(LISTENER, { p: "open-sesame" })}&f=json`,
    );
    const body = (await response.json()) as JsonEnvelope;

    expect(body["subsonic-response"]).toMatchObject({ status: "failed", error: { code: 40 } });
  });
});
