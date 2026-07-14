import { describe, it, expect } from "vitest";
import { filterTagsForBulkSelect } from "@/lib/gallery/tagSelectFilter";

const TAGS = [
  { id: "t1", name: "海" },
  { id: "t2", name: "プール" },
  { id: "t3", name: "Beach" },
];

describe("filterTagsForBulkSelect", () => {
  it("returns all tags when query is empty", () => {
    expect(filterTagsForBulkSelect(TAGS, "")).toEqual(TAGS);
  });

  it("returns all tags when query is whitespace-only", () => {
    expect(filterTagsForBulkSelect(TAGS, "   ")).toEqual(TAGS);
  });

  it("filters by case-insensitive substring match", () => {
    expect(filterTagsForBulkSelect(TAGS, "beach")).toEqual([
      { id: "t3", name: "Beach" },
    ]);
  });

  it("matches Japanese substrings", () => {
    expect(filterTagsForBulkSelect(TAGS, "プー")).toEqual([
      { id: "t2", name: "プール" },
    ]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterTagsForBulkSelect(TAGS, "zzz")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const copy = [...TAGS];
    filterTagsForBulkSelect(TAGS, "海");
    expect(TAGS).toEqual(copy);
  });

  it("handles an empty list", () => {
    expect(filterTagsForBulkSelect([], "anything")).toEqual([]);
  });
});
