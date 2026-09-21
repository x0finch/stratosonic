import { describe, expect, it } from "vitest";
import {
  groupArtistsByIndex,
  IGNORED_ARTICLES,
  indexKeyOf,
  indexOrderName,
  parseIndexGroups,
} from "../src/library/artist-index";

/**
 * The index bucketing, on its own: which letter an artist falls under is a
 * pure function of its name, and it is the part of `getArtists` with the most
 * rules in it.
 */

describe("parseIndexGroups", () => {
  it("maps a plain entry to itself", () => {
    expect(parseIndexGroups("A B C").get("a")).toBe("A");
  });

  it("maps every character of a group to the group's label", () => {
    const groups = parseIndexGroups("X-Z(XYZ)");

    expect(groups.get("x")).toBe("X-Z");
    expect(groups.get("y")).toBe("X-Z");
    expect(groups.get("z")).toBe("X-Z");
  });

  it("reads a label that contains brackets, as the default spec does", () => {
    expect(parseIndexGroups("[Unknown]([)").get("[")).toBe("[Unknown]");
  });
});

describe("indexOrderName", () => {
  it("lowercases and trims", () => {
    expect(indexOrderName("  Mute Ensemble  ")).toBe("mute ensemble");
  });

  it("drops a leading article", () => {
    expect(indexOrderName("The Silent Type")).toBe("silent type");
    expect(indexOrderName("Los Amigos")).toBe("amigos");
  });

  it("keeps an article that is part of the first word", () => {
    expect(indexOrderName("Theatre Royal")).toBe("theatre royal");
  });

  it("compares articles with their case, as Navidrome's RemoveArticle does", () => {
    expect(indexOrderName("the lowercase band")).toBe("the lowercase band");
  });

  it("folds accents onto the letter they are written with", () => {
    expect(indexOrderName("Éclair Quartet")).toBe("eclair quartet");
  });
});

describe("indexKeyOf", () => {
  it("buckets by the first letter of the name it sorts under", () => {
    expect(indexKeyOf("Mute Ensemble")).toBe("M");
    expect(indexKeyOf("The Silent Type")).toBe("S");
    expect(indexKeyOf("Éclair Quartet")).toBe("E");
  });

  it("puts X, Y and Z in one bucket", () => {
    expect(indexKeyOf("Xenon")).toBe("X-Z");
    expect(indexKeyOf("Yellow Door")).toBe("X-Z");
    expect(indexKeyOf("Zephyr Youth")).toBe("X-Z");
  });

  it("puts a name no group claims under #", () => {
    expect(indexKeyOf("4 Non Blondes")).toBe("#");
    expect(indexKeyOf("!!!")).toBe("#");
    expect(indexKeyOf("")).toBe("#");
  });
});

describe("groupArtistsByIndex", () => {
  const artists = [
    { name: "Zephyr Youth" },
    { name: "The Silent Type" },
    { name: "4 Non Blondes" },
    { name: "Mute Ensemble" },
    { name: "Sable" },
  ];

  it("orders the buckets by name, with # first", () => {
    const indexes = groupArtistsByIndex(artists, (artist) => artist.name);

    expect(indexes.map((index) => index.name)).toEqual(["#", "M", "S", "X-Z"]);
  });

  it("orders the artists of a bucket by the name they sort under", () => {
    const indexes = groupArtistsByIndex(artists, (artist) => artist.name);
    const sables = indexes.find((index) => index.name === "S");

    // "The Silent Type" sorts as "silent type", so it follows "sable" rather
    // than leading the bucket as its spelling would.
    expect(sables?.artists.map((artist) => artist.name)).toEqual(["Sable", "The Silent Type"]);
  });

  it("groups nothing into nothing", () => {
    expect(groupArtistsByIndex([], (artist: { name: string }) => artist.name)).toEqual([]);
  });
});

describe("IGNORED_ARTICLES", () => {
  it("is Navidrome's default list, which is what clients are told", () => {
    expect(IGNORED_ARTICLES).toBe("The El La Los Las Le Les Os As O A");
  });
});
