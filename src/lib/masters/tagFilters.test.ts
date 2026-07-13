import { describe, it, expect } from "vitest";
import { filterTagsForMasters } from "@/lib/masters/tagFilters";

const TAGS = [
  { id: "t1", name: "海", imageCount: 5 },
  { id: "t2", name: "海辺", imageCount: 0 },
  { id: "t3", name: "プール", imageCount: 2 },
  { id: "t4", name: "プールサイド", imageCount: 0 },
];

describe("filterTagsForMasters", () => {
  it("unusedOnly=false (default) returns all tags unchanged", () => {
    expect(filterTagsForMasters(TAGS)).toEqual(TAGS);
    expect(filterTagsForMasters(TAGS, { unusedOnly: false })).toEqual(TAGS);
  });

  it("unusedOnly=true returns only imageCount === 0 tags", () => {
    expect(filterTagsForMasters(TAGS, { unusedOnly: true })).toEqual([
      { id: "t2", name: "海辺", imageCount: 0 },
      { id: "t4", name: "プールサイド", imageCount: 0 },
    ]);
  });

  it("excludes tags with imageCount > 0 when unusedOnly=true", () => {
    const result = filterTagsForMasters(TAGS, { unusedOnly: true });
    expect(result.some((t) => t.imageCount > 0)).toBe(false);
  });

  it("query filters by case-insensitive substring match", () => {
    expect(filterTagsForMasters(TAGS, { query: "プール" })).toEqual([
      { id: "t3", name: "プール", imageCount: 2 },
      { id: "t4", name: "プールサイド", imageCount: 0 },
    ]);
  });

  it("composes query and unusedOnly together", () => {
    expect(filterTagsForMasters(TAGS, { query: "プール", unusedOnly: true })).toEqual([
      { id: "t4", name: "プールサイド", imageCount: 0 },
    ]);
  });

  it("blank/whitespace-only query is a no-op", () => {
    expect(filterTagsForMasters(TAGS, { query: "   " })).toEqual(TAGS);
  });

  it("does not mutate the input array", () => {
    const copy = JSON.parse(JSON.stringify(TAGS));
    filterTagsForMasters(TAGS, { unusedOnly: true, query: "海" });
    expect(TAGS).toEqual(copy);
  });

  it("empty input returns empty output", () => {
    expect(filterTagsForMasters([], { unusedOnly: true })).toEqual([]);
  });

  it("no matches under unusedOnly returns an empty array", () => {
    const allUsed = [
      { id: "t1", name: "海", imageCount: 5 },
      { id: "t2", name: "プール", imageCount: 2 },
    ];
    expect(filterTagsForMasters(allUsed, { unusedOnly: true })).toEqual([]);
  });
});
