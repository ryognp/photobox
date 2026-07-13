import { describe, it, expect } from "vitest";
import { filterPersonsForBulkSelect } from "@/lib/gallery/personSelectFilter";

const PERSONS = [
  { id: "p1", name: "凛" },
  { id: "p2", name: "陽菜" },
  { id: "p3", name: "Rin" },
];

describe("filterPersonsForBulkSelect", () => {
  it("returns all persons when query is empty", () => {
    expect(filterPersonsForBulkSelect(PERSONS, "")).toEqual(PERSONS);
  });

  it("returns all persons when query is whitespace-only", () => {
    expect(filterPersonsForBulkSelect(PERSONS, "   ")).toEqual(PERSONS);
  });

  it("filters by case-insensitive substring match", () => {
    expect(filterPersonsForBulkSelect(PERSONS, "rin")).toEqual([
      { id: "p3", name: "Rin" },
    ]);
  });

  it("matches Japanese substrings", () => {
    expect(filterPersonsForBulkSelect(PERSONS, "陽")).toEqual([
      { id: "p2", name: "陽菜" },
    ]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterPersonsForBulkSelect(PERSONS, "zzz")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const copy = [...PERSONS];
    filterPersonsForBulkSelect(PERSONS, "凛");
    expect(PERSONS).toEqual(copy);
  });

  it("handles an empty list", () => {
    expect(filterPersonsForBulkSelect([], "anything")).toEqual([]);
  });
});
