import { describe, it, expect } from "vitest";
import { addUniqueById } from "@/lib/gallery/personState";

describe("addUniqueById", () => {
  const persons = [
    { id: "a", name: "田中" },
    { id: "b", name: "鈴木" },
  ];

  it("appends a new item", () => {
    expect(addUniqueById(persons, { id: "c", name: "佐藤" })).toEqual([
      { id: "a", name: "田中" },
      { id: "b", name: "鈴木" },
      { id: "c", name: "佐藤" },
    ]);
  });

  it("does not add a duplicate id (no-op, client-side idempotent)", () => {
    expect(addUniqueById(persons, { id: "a", name: "田中" })).toEqual(persons);
  });

  it("does not add a duplicate id even if the name differs", () => {
    // id is the identity — a same-id item with a different name (shouldn't
    // happen in practice, but the dedup key must stay id-based) is still a no-op.
    expect(addUniqueById(persons, { id: "a", name: "違う名前" })).toEqual(persons);
  });

  it("returns a new array (does not mutate input)", () => {
    const result = addUniqueById(persons, { id: "c", name: "佐藤" });
    expect(result).not.toBe(persons);
    expect(persons).toHaveLength(2);
  });

  it("handles an empty list", () => {
    expect(addUniqueById([], { id: "a", name: "田中" })).toEqual([{ id: "a", name: "田中" }]);
  });
});
