import { describe, it, expect } from "vitest";
import { removeTagById } from "@/lib/gallery/tagState";

describe("removeTagById", () => {
  const tags = [
    { id: "a", name: "猫" },
    { id: "b", name: "風景" },
    { id: "c", name: "カフェ" },
  ];

  it("removes the matching tag", () => {
    expect(removeTagById(tags, "b")).toEqual([
      { id: "a", name: "猫" },
      { id: "c", name: "カフェ" },
    ]);
  });

  it("is a no-op when the tagId is absent (client-side idempotent)", () => {
    expect(removeTagById(tags, "zzz")).toEqual(tags);
  });

  it("returns a new array (does not mutate input)", () => {
    const result = removeTagById(tags, "a");
    expect(result).not.toBe(tags);
    expect(tags).toHaveLength(3);
  });

  it("handles an empty list", () => {
    expect(removeTagById([], "a")).toEqual([]);
  });
});
