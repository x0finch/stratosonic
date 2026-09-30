import { describe, expect, it } from "vitest";

import type { Me } from "@/lib/api";
import { can, roleLabel } from "@/lib/roles";

describe("roleLabel", () => {
  it("names the owner role Owner", () => {
    expect(roleLabel("owner")).toBe("Owner");
  });

  it("shows a role it has no words for as it is", () => {
    expect(roleLabel("read-only")).toBe("read-only");
    expect(roleLabel("constructor")).toBe("constructor");
    expect(roleLabel("")).toBe("No role");
  });
});

describe("can", () => {
  const me: Me = {
    id: "1",
    username: "owner",
    role: "owner",
    permissions: ["account:change-password"],
  };

  it("follows the permissions the server answered", () => {
    expect(can(me, "account:change-password")).toBe(true);
    expect(can(me, "library:scan")).toBe(false);
    expect(can({ ...me, role: "read-only", permissions: [] }, "account:change-password")).toBe(
      false,
    );
  });

  it("grants nothing while no one is signed in", () => {
    expect(can(null, "account:change-password")).toBe(false);
    expect(can(undefined, "account:change-password")).toBe(false);
  });
});
