import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE, type JsonEnvelope, type SubsonicUser, seedUser } from "./support";

/**
 * `getUser` against the Worker. The bootstrap admin (`admin` / `sesame`, from
 * the test bindings) exists in this file's database; the listener is seeded
 * here to cover a user without the admin flag.
 */

const ADMIN = "admin";
const LISTENER = "listener";
const CURATOR = "curator";
const CURATOR_EMAIL = "curator@stratosonic.test";
const PASSWORD = "sesame";

/** Credentials plus whatever the call needs, as a query string. */
function query(userName: string, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    u: userName,
    p: PASSWORD,
    v: "1.16.1",
    c: "Substreamer",
    ...extra,
  }).toString();
}

async function getUser(
  userName: string,
  extra: Record<string, string> = {},
): Promise<JsonEnvelope["subsonic-response"]> {
  const response = await SELF.fetch(`${BASE}/rest/getUser?${query(userName, extra)}&f=json`);
  const body = (await response.json()) as JsonEnvelope;

  return body["subsonic-response"];
}

/** Every role attribute Navidrome's `responses.User` declares, and no other. */
function rolesOf(user: SubsonicUser): Record<string, unknown> {
  const { username: _username, email: _email, folder: _folder, ...roles } = user;

  return roles;
}

beforeAll(async () => {
  // The bootstrap only creates the admin while the user table is empty, so the
  // first request has to reach the Worker before anything else is seeded.
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedUser(LISTENER, PASSWORD);
  await seedUser(CURATOR, PASSWORD, false, CURATOR_EMAIL);
});

describe("getUser", () => {
  it.each(["/rest/getUser", "/rest/getUser.view"])(
    "returns the caller's own account on %s",
    async (path) => {
      const xml = await (
        await SELF.fetch(`${BASE}${path}?${query(ADMIN, { username: ADMIN })}`)
      ).text();

      expect(xml).toContain('status="ok"');
      expect(xml).toContain('<user username="admin"');
      expect(xml).toContain("<folder>1</folder>");
    },
  );

  it("reports an admin's roles, with adminRole and coverArtRole set", async () => {
    const body = await getUser(ADMIN, { username: ADMIN });

    expect(body.status).toBe("ok");
    expect(body.user?.username).toBe(ADMIN);
    expect(rolesOf(body.user as SubsonicUser)).toEqual({
      scrobblingEnabled: true,
      adminRole: true,
      settingsRole: false,
      downloadRole: true,
      uploadRole: false,
      playlistRole: false,
      coverArtRole: true,
      commentRole: false,
      podcastRole: false,
      streamRole: true,
      jukeboxRole: false,
      shareRole: false,
      videoConversionRole: false,
    });
  });

  it("clears adminRole and coverArtRole for a user who is not an admin", async () => {
    const body = await getUser(LISTENER, { username: LISTENER });

    expect(body.user).toMatchObject({
      username: LISTENER,
      adminRole: false,
      coverArtRole: false,
      streamRole: true,
      downloadRole: true,
      scrobblingEnabled: true,
      shareRole: false,
      jukeboxRole: false,
    });
  });

  it("reports the single music folder as an array in JSON", async () => {
    const body = await getUser(LISTENER, { username: LISTENER });

    expect(body.user?.folder).toEqual([1]);
  });

  it("omits the email attribute for an account that has none", async () => {
    const body = await getUser(LISTENER, { username: LISTENER });
    const xml = await (
      await SELF.fetch(`${BASE}/rest/getUser?${query(LISTENER, { username: LISTENER })}`)
    ).text();

    expect(body.user?.email).toBeUndefined();
    expect(xml).not.toContain("email=");
  });

  it("reports the address of an account that has one", async () => {
    const body = await getUser(CURATOR, { username: CURATOR });
    const xml = await (
      await SELF.fetch(`${BASE}/rest/getUser?${query(CURATOR, { username: CURATOR })}`)
    ).text();

    expect(body.user?.email).toBe(CURATOR_EMAIL);
    expect(xml).toContain(`email="${CURATOR_EMAIL}"`);
  });

  it("matches the requested username case-insensitively", async () => {
    const body = await getUser(LISTENER, { username: LISTENER.toUpperCase() });

    expect(body.status).toBe("ok");
    expect(body.user?.username).toBe(LISTENER);
  });

  it("refuses another user's account with error 50", async () => {
    const body = await getUser(LISTENER, { username: ADMIN });

    expect(body).toMatchObject({
      status: "failed",
      error: { code: 50, message: "User is not authorized for the given operation" },
    });
    expect(body.user).toBeUndefined();
  });

  it("refuses it for an admin too, who has no more right to another account", async () => {
    const body = await getUser(ADMIN, { username: LISTENER });

    expect(body).toMatchObject({ status: "failed", error: { code: 50 } });
    expect(body.user).toBeUndefined();
  });

  it("reports a missing username as error 10", async () => {
    const body = await getUser(ADMIN);

    expect(body).toMatchObject({
      status: "failed",
      error: { code: 10, message: "missing parameter: 'username'" },
    });
  });

  it("is behind authentication", async () => {
    const body = await getUser(ADMIN, { p: "open-sesame", username: ADMIN });

    expect(body).toMatchObject({ status: "failed", error: { code: 40 } });
  });
});
