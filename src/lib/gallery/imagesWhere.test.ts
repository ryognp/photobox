import { describe, it, expect } from "vitest";
import { buildImagesWhere } from "@/lib/gallery/imagesWhere";
import { getCurrentAnalysisModelIdSuffix } from "@/lib/analysis/currentAnalysisSuggestionFilter";

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

  // Phase 10-9B: suggestionLabels (PENDING AI-candidate) filter
  it("no AND when both tagIds and suggestionLabels are empty (backward compat)", () => {
    const where = buildImagesWhere({ ...BASE, suggestionLabels: [] });
    expect(where.AND).toBeUndefined();
  });

  it("suggestionLabels omitted → treated as empty (backward compat)", () => {
    const where = buildImagesWhere(BASE); // no suggestionLabels key
    expect(where.AND).toBeUndefined();
  });

  it("single suggestionLabel → PENDING + workspaceId scoped some clause", () => {
    const where = buildImagesWhere({ ...BASE, suggestionLabels: ["水着"] });
    expect(where.AND).toEqual([
      { tagSuggestions: { some: { status: "PENDING", label: "水着", workspaceId: "ws1" } } },
    ]);
  });

  it("multiple suggestionLabels are ANDed", () => {
    const where = buildImagesWhere({ ...BASE, suggestionLabels: ["水着", "海"] });
    expect(where.AND).toEqual([
      { tagSuggestions: { some: { status: "PENDING", label: "水着", workspaceId: "ws1" } } },
      { tagSuggestions: { some: { status: "PENDING", label: "海", workspaceId: "ws1" } } },
    ]);
  });

  it("tagIds + suggestionLabels merge into a SINGLE AND array (tagIds first)", () => {
    const where = buildImagesWhere({ ...BASE, tagIds: ["t1"], suggestionLabels: ["水着"] });
    expect(where.AND).toEqual([
      { imageTags: { some: { tagId: "t1" } } },
      { tagSuggestions: { some: { status: "PENDING", label: "水着", workspaceId: "ws1" } } },
    ]);
  });

  it("q + tagIds + suggestionLabels all combine (OR present, single merged AND)", () => {
    const where = buildImagesWhere({
      ...BASE,
      q: "cat",
      tagIds: ["t1"],
      suggestionLabels: ["海"],
    }) as { OR?: unknown[]; AND?: unknown[] };
    expect(where.OR).toBeDefined();
    expect(where.AND).toEqual([
      { imageTags: { some: { tagId: "t1" } } },
      { tagSuggestions: { some: { status: "PENDING", label: "海", workspaceId: "ws1" } } },
    ]);
  });

  // Phase 10-28B: organization quick filters (untagged / unpersoned / hasSuggestions)
  it("untagged omitted/false → no AND (backward compat)", () => {
    expect(buildImagesWhere(BASE).AND).toBeUndefined();
    expect(buildImagesWhere({ ...BASE, untagged: false }).AND).toBeUndefined();
  });

  it("untagged=true → imageTags none clause", () => {
    const where = buildImagesWhere({ ...BASE, untagged: true });
    expect(where.AND).toEqual([{ imageTags: { none: {} } }]);
  });

  it("unpersoned omitted/false → no AND (backward compat)", () => {
    expect(buildImagesWhere({ ...BASE, unpersoned: false }).AND).toBeUndefined();
  });

  it("unpersoned=true → imagePersons none clause", () => {
    const where = buildImagesWhere({ ...BASE, unpersoned: true });
    expect(where.AND).toEqual([{ imagePersons: { none: {} } }]);
  });

  it("hasSuggestions omitted/false → no AND (backward compat)", () => {
    expect(buildImagesWhere({ ...BASE, hasSuggestions: false }).AND).toBeUndefined();
  });

  it("hasSuggestions=true → PENDING + workspaceId + current-model analysis clause", () => {
    const where = buildImagesWhere({ ...BASE, hasSuggestions: true });
    expect(where.AND).toEqual([
      {
        tagSuggestions: {
          some: {
            status: "PENDING",
            workspaceId: "ws1",
            analysis: { modelId: { endsWith: getCurrentAnalysisModelIdSuffix() } },
          },
        },
      },
    ]);
  });

  it("untagged + unpersoned + hasSuggestions all combine into one AND array", () => {
    const where = buildImagesWhere({ ...BASE, untagged: true, unpersoned: true, hasSuggestions: true });
    expect(where.AND).toEqual([
      { imageTags: { none: {} } },
      { imagePersons: { none: {} } },
      {
        tagSuggestions: {
          some: {
            status: "PENDING",
            workspaceId: "ws1",
            analysis: { modelId: { endsWith: getCurrentAnalysisModelIdSuffix() } },
          },
        },
      },
    ]);
  });

  it("untagged + tagIds combine into one AND array (contradictory but not specially handled)", () => {
    const where = buildImagesWhere({ ...BASE, untagged: true, tagIds: ["t1"] });
    expect(where.AND).toEqual([
      { imageTags: { some: { tagId: "t1" } } },
      { imageTags: { none: {} } },
    ]);
  });
});
