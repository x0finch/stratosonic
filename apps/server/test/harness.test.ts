import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("runs against a D1 database with the migrations applied", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'property'",
    ).first<{ name: string }>();

    expect(row?.name).toBe("property");
  });

  it("reads back rows written to the migrated schema", async () => {
    await env.DB.prepare("INSERT INTO property (id, value) VALUES (?1, ?2)")
      .bind("harness-probe", "written")
      .run();

    const row = await env.DB.prepare("SELECT value FROM property WHERE id = ?1")
      .bind("harness-probe")
      .first<{ value: string }>();

    expect(row?.value).toBe("written");
  });

  it("applies the column defaults from the migration", async () => {
    await env.DB.prepare("INSERT INTO property (id) VALUES (?1)").bind("harness-default").run();

    const row = await env.DB.prepare("SELECT value FROM property WHERE id = ?1")
      .bind("harness-default")
      .first<{ value: string }>();

    expect(row?.value).toBe("");
  });

  it("exposes the R2 music bucket binding", async () => {
    await env.MUSIC.put("probe.txt", "ok");

    expect(await env.MUSIC.head("probe.txt")).not.toBeNull();
  });
});
