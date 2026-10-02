import { describe, expect, it } from "vitest";
import {
  isKnownRole,
  OWNER_ROLE,
  PERMISSIONS,
  permissionsOf,
  ROLES,
  roleGrants,
} from "../src/console-auth/permissions";

/**
 * The registry of the console's permissions and the roles that grant them
 * (#99): `owner`, the one role there is, grants every permission, and a role
 * the registry does not know grants none.
 */

describe("the permissions", () => {
  it("are each declared once, as <area>:<action>", () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(/^[a-z-]+:[a-z-]+$/);
    }
  });

  it("include what the console asks for now, and what Phases 1 and 2 do", () => {
    expect(PERMISSIONS).toEqual(
      expect.arrayContaining([
        "account:change-password",
        "subsonic-users:read",
        "subsonic-users:write",
        "library:read",
        "activity:read",
        "library:scan",
        "usage:read",
        "files:read",
        "files:write",
      ]),
    );
  });
});

describe("the roles", () => {
  it("are owner alone for now, called Owner, which setup gives", () => {
    expect(Object.keys(ROLES)).toEqual(["owner"]);
    expect(ROLES.owner.label).toBe("Owner");
    expect(OWNER_ROLE).toBe("owner");
  });

  it("give the owner every declared permission", () => {
    expect([...permissionsOf("owner")].sort()).toEqual([...PERMISSIONS].sort());
    for (const permission of PERMISSIONS) {
      expect(roleGrants("owner", permission), permission).toBe(true);
    }
  });

  it.each([
    ["an unknown role", "read-only"],
    ["the Subsonic role", "admin"],
    ["another case of owner", "Owner"],
    ["no role", ""],
    ["an inherited property", "constructor"],
    ["an inherited property", "__proto__"],
  ])("give %s (%j) nothing: they fail closed", (_, role) => {
    expect(isKnownRole(role)).toBe(false);
    expect(permissionsOf(role)).toEqual([]);
    for (const permission of PERMISSIONS) {
      expect(roleGrants(role, permission), permission).toBe(false);
    }
  });
});
