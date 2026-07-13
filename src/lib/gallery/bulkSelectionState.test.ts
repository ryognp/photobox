import { describe, it, expect } from "vitest";
import {
  toggleBulkSelectedId,
  clearBulkSelectedIds,
  reconcileBulkSelectedIds,
} from "@/lib/gallery/bulkSelectionState";

describe("toggleBulkSelectedId", () => {
  it("adds an unselected id", () => {
    expect(toggleBulkSelectedId(["a"], "b")).toEqual(["a", "b"]);
  });

  it("removes an already-selected id", () => {
    expect(toggleBulkSelectedId(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("does not create duplicates", () => {
    const once = toggleBulkSelectedId([], "a");
    expect(once).toEqual(["a"]);
    const twice = toggleBulkSelectedId(once, "a");
    expect(twice).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b"];
    const copy = [...input];
    toggleBulkSelectedId(input, "c");
    toggleBulkSelectedId(input, "a");
    expect(input).toEqual(copy);
  });
});

describe("clearBulkSelectedIds", () => {
  it("returns an empty array", () => {
    expect(clearBulkSelectedIds()).toEqual([]);
  });
});

describe("reconcileBulkSelectedIds", () => {
  it("drops ids not among visible images", () => {
    expect(reconcileBulkSelectedIds(["a", "b", "c"], ["a", "c", "d"])).toEqual(["a", "c"]);
  });

  it("preserves the order of remaining selected ids", () => {
    expect(reconcileBulkSelectedIds(["c", "a", "b"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  });

  it("returns empty when no selected id is visible", () => {
    expect(reconcileBulkSelectedIds(["x", "y"], ["a", "b"])).toEqual([]);
  });

  it("returns empty when the selection is already empty", () => {
    expect(reconcileBulkSelectedIds([], ["a", "b"])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b", "c"];
    const copy = [...input];
    reconcileBulkSelectedIds(input, ["a"]);
    expect(input).toEqual(copy);
  });
});
