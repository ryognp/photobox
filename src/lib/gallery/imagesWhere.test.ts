import { describe, it, expect } from "vitest";
import { buildImagesWhere } from "@/lib/gallery/imagesWhere";

const BASE = { workspaceId: "ws1", q: "", sceneId: null, personId: null, favorite: null, tagIds: [] as string[] };

describe("buildImagesWhere", () => {
  it("always includes workspaceId/deletedAt/status", () => {
    const where = buildImagesWhere(BASE);
    expect(where.workspaceId).toBe("ws1");
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe("ACTIVE");
  });

  it("no tag condition when tagIds is empty", () => {
    const where = buildImagesWhere(BASE);
    expect(where.AND).toBeUndefined();
  });

  it("single tagId produces one AND clause", () => {
    const where = buildImagesWhere({ ...BASE, tagIds: ["t1"] });
    expect(where.AND).toEqual([{ imageTags: { some: { tagId: "t1" } } }]);
  });

  it("multiple tagIds are ANDed (must have ALL tags)", () => {
    const where = buildImagesWhere({ ...BASE, tagIds: ["t1", "t2", "t3"] });
    expect(where.AND).toEqual([
      { imageTags: { some: { tagId: "t1" } } },
      { imageTags: { some: { tagId: "t2" } } },
      { imageTags: { some: { tagId: "t3" } } },
    ]);
  });

  it("q builds an OR filter across searchText/originalName/notes/prompt", () => {
    const where = buildImagesWhere({ ...BASE, q: "cat" }) as { OR?: unknown[] };
    expect(where.OR).toBeDefined();
    expect(where.OR).toHaveLength(5);
  });

  it("q + tagIds combine (both applied, top-level AND with plain fields)", () => {
    const where = buildImagesWhere({ ...BASE, q: "cat", tagIds: ["t1"] }) as {
      OR?: unknown[];
      AND?: unknown[];
    };
    expect(where.OR).toBeDefined();
    expect(where.AND).toEqual([{ imageTags: { some: { tagId: "t1" } } }]);
  });

  it("sceneId / personId / favorite are applied when set", () => {
    const where = buildImagesWhere({ ...BASE, sceneId: "s1", personId: "p1", favorite: true });
    expect(where.sceneId).toBe("s1");
    expect(where.imagePersons).toEqual({ some: { personId: "p1" } });
    expect(where.isFavorite).toBe(true);
  });

  it("favorite=false is applied (not treated as absent)", () => {
    const where = buildImagesWhere({ ...BASE, favorite: false });
    expect(where.isFavorite).toBe(false);
  });
});
