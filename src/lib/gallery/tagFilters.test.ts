import { describe, it, expect } from "vitest";
import { normalizeTagIds, toggleTagId } from "@/lib/gallery/tagFilters";

describe("normalizeTagIds", () => {
  it("empty when both absent", () => {
    expect(normalizeTagIds({})).toEqual([]);
    expect(normalizeTagIds({ tagId: null, tagIdsParam: null })).toEqual([]);
  });

  it("parses comma-separated tagIdsParam", () => {
    expect(normalizeTagIds({ tagIdsParam: "a,b,c" })).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace and drops empty entries", () => {
    expect(normalizeTagIds({ tagIdsParam: " a , , b ,," })).toEqual(["a", "b"]);
  });

  it("legacy single tagId alone works", () => {
    expect(normalizeTagIds({ tagId: "x" })).toEqual(["x"]);
  });

  it("merges tagId + tagIdsParam and dedupes", () => {
    expect(normalizeTagIds({ tagId: "a", tagIdsParam: "a,b" })).toEqual(["a", "b"]);
  });

  it("blank tagId is ignored", () => {
    expect(normalizeTagIds({ tagId: "   ", tagIdsParam: "a" })).toEqual(["a"]);
  });
});

describe("toggleTagId", () => {
  it("adds an absent id", () => {
    expect(toggleTagId(["a"], "b")).toEqual(["a", "b"]);
  });
  it("removes a present id", () => {
    expect(toggleTagId(["a", "b"], "a")).toEqual(["b"]);
  });
  it("empty list + toggle → single item", () => {
    expect(toggleTagId([], "a")).toEqual(["a"]);
  });
  it("does not mutate the input array", () => {
    const input = ["a"];
    toggleTagId(input, "b");
    expect(input).toEqual(["a"]);
  });
});
