import { describe, expect, it } from "vitest";

import { safeRedirect } from "@/lib/redirect";

const ORIGIN = "https://music.example";

describe("safeRedirect", () => {
  it("keeps a console page, with its search and hash", () => {
    expect(safeRedirect("/account", ORIGIN)).toBe("/account");
    expect(safeRedirect("/users?page=2#top", ORIGIN)).toBe("/users?page=2#top");
    expect(safeRedirect("/", ORIGIN)).toBe("/");
  });

  it("sends anything that is not a path to the overview", () => {
    for (const target of [undefined, null, 42, "", "account", "https://evil.example/"]) {
      expect(safeRedirect(target, ORIGIN)).toBe("/");
    }
  });

  it("refuses a path that leads to another origin", () => {
    for (const target of ["//evil.example/", "/\\evil.example/", "/\\/evil.example"]) {
      expect(safeRedirect(target, ORIGIN)).toBe("/");
    }
  });

  it("refuses a path that dot segments turn into a protocol-relative one", () => {
    for (const target of [
      "/.//evil.example",
      "/a/..//evil.example",
      "/..//evil.example",
      "/%2e//evil.example",
      "/./\\evil.example",
    ]) {
      expect(safeRedirect(target, ORIGIN)).toBe("/");
    }
  });

  it("refuses the paths the Worker answers, which are not console pages", () => {
    for (const target of ["/api/me", "/api", "/rest/ping", "/share/img/x"]) {
      expect(safeRedirect(target, ORIGIN)).toBe("/");
    }
  });

  it("refuses the sign-in and setup screens, which would lead nowhere", () => {
    for (const target of ["/login", "/login?redirect=/account", "/setup", "/setup/"]) {
      expect(safeRedirect(target, ORIGIN)).toBe("/");
    }
  });

  it("does not mistake a page that merely starts with a Worker path", () => {
    expect(safeRedirect("/apis", ORIGIN)).toBe("/apis");
    expect(safeRedirect("/restore", ORIGIN)).toBe("/restore");
  });
});
