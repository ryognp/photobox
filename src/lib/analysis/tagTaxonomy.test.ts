import { describe, it, expect } from "vitest";
import {
  normalizeTagLabel,
  isBannedTagLabel,
  isExcludedGenericLabel,
  getTagCategory,
  refineTagCandidates,
} from "@/lib/analysis/tagTaxonomy";

describe("normalizeTagLabel", () => {
  it("maps synonyms to canonical vocabulary", () => {
    expect(normalizeTagLabel("海辺")).toBe("海");
    expect(normalizeTagLabel("海岸")).toBe("海");
    expect(normalizeTagLabel("ビーチサイド")).toBe("ビーチ");
    expect(normalizeTagLabel("プールサイド")).toBe("プール");
    expect(normalizeTagLabel("テラス席")).toBe("テラス");
    expect(normalizeTagLabel("夕暮れ")).toBe("夕方");
    expect(normalizeTagLabel("夕焼け")).toBe("夕方");
    expect(normalizeTagLabel("夜景")).toBe("夜");
    expect(normalizeTagLabel("朝焼け")).toBe("朝");
    expect(normalizeTagLabel("ビキニ")).toBe("水着");
    expect(normalizeTagLabel("スイムウェア")).toBe("水着");
    expect(normalizeTagLabel("ワンピースドレス")).toBe("ドレス");
  });

  it("trims and is identity for non-synonyms", () => {
    expect(normalizeTagLabel("  海 ")).toBe("海");
    expect(normalizeTagLabel("ポートレート")).toBe("ポートレート"); // no longer in vocab, but normalize itself is identity
  });

  it("Phase 10-10A: maps English time-of-day terms to the JA vocabulary", () => {
    expect(normalizeTagLabel("sunset")).toBe("夕方");
    expect(normalizeTagLabel("dusk")).toBe("夕方");
    expect(normalizeTagLabel("twilight")).toBe("夕方");
    expect(normalizeTagLabel("golden hour")).toBe("夕方");
    expect(normalizeTagLabel("evening")).toBe("夕方");
    expect(normalizeTagLabel("night")).toBe("夜");
    expect(normalizeTagLabel("nighttime")).toBe("夜");
    expect(normalizeTagLabel("morning")).toBe("朝");
    expect(normalizeTagLabel("sunrise")).toBe("朝");
    expect(normalizeTagLabel("daytime")).toBe("昼");
    expect(normalizeTagLabel("noon")).toBe("昼");
    expect(normalizeTagLabel("afternoon")).toBe("昼");
  });

  it("Phase 10-10A: English synonym lookup is case-insensitive", () => {
    expect(normalizeTagLabel("Sunset")).toBe("夕方");
    expect(normalizeTagLabel("SUNSET")).toBe("夕方");
    expect(normalizeTagLabel("Golden Hour")).toBe("夕方");
  });
});

describe("isBannedTagLabel", () => {
  it("flags exact banned description/atmosphere words", () => {
    for (const t of ["素材", "参考画像", "エアリー", "ミニマル", "肌の質感", "柔らかな自然光"]) {
      expect(isBannedTagLabel(t)).toBe(true);
    }
  });
  it("flags suffix patterns (〜の描写 / 〜の背景 / 〜のシーン / 〜の質感 / 〜な雰囲気)", () => {
    for (const t of [
      "夕暮れ時の光学用シーンの描写",
      "テラスの背景",
      "開放感のあるシーン",
      "透明感のある空気感の質感",
      "ミニマルな雰囲気",
    ]) {
      expect(isBannedTagLabel(t)).toBe(true);
    }
  });
  it("empty is banned", () => {
    expect(isBannedTagLabel("   ")).toBe(true);
  });
  it("does not flag controlled-vocabulary words", () => {
    for (const t of ["海", "夕方", "水着", "自然光", "高級感", "夕景"]) {
      expect(isBannedTagLabel(t)).toBe(false);
    }
  });
});

describe("isExcludedGenericLabel (Phase 10-10A)", () => {
  it("flags 人物 and ポートレート", () => {
    expect(isExcludedGenericLabel("人物")).toBe(true);
    expect(isExcludedGenericLabel("ポートレート")).toBe(true);
  });
  it("trims before matching", () => {
    expect(isExcludedGenericLabel("  人物 ")).toBe(true);
  });
  it("does not flag other controlled-vocabulary words", () => {
    for (const t of ["海", "夕方", "水着", "自然光", "高級感", "風景", "建物", "犬", "猫"]) {
      expect(isExcludedGenericLabel(t)).toBe(false);
    }
  });
});

describe("getTagCategory", () => {
  it("returns the category for vocabulary words", () => {
    expect(getTagCategory("朝")).toBe("time");
    expect(getTagCategory("水着")).toBe("outfit");
    expect(getTagCategory("海")).toBe("place");
    expect(getTagCategory("全身")).toBe("composition");
    expect(getTagCategory("自然光")).toBe("light");
    expect(getTagCategory("風景")).toBe("subject");
    expect(getTagCategory("高級感")).toBe("mood");
  });

  it("Phase 10-10A: 人物 and ポートレート are no longer in the controlled vocabulary", () => {
    expect(getTagCategory("人物")).toBeUndefined();
    expect(getTagCategory("ポートレート")).toBeUndefined();
  });

  it("returns undefined for out-of-vocabulary words", () => {
    expect(getTagCategory("エアリー")).toBeUndefined();
    expect(getTagCategory("セクシー")).toBeUndefined(); // intentionally excluded
    expect(getTagCategory("肌の質感")).toBeUndefined();
  });
});

describe("refineTagCandidates", () => {
  it("drops out-of-vocabulary tags (controlled vocabulary)", () => {
    const out = refineTagCandidates([{ label: "エアリー" }, { label: "透明感" }, { label: "海" }]);
    expect(out.map((t) => t.label)).toEqual(["海"]);
  });

  it("normalizes synonyms and dedupes to the canonical label", () => {
    const out = refineTagCandidates([{ label: "海辺" }, { label: "海" }, { label: "海岸" }]);
    expect(out.map((t) => t.label)).toEqual(["海"]);
  });

  it("Phase 10-10A: 人物 and ポートレート are excluded (too generic for Photo.box)", () => {
    expect(refineTagCandidates([{ label: "人物" }, { label: "ポートレート" }])).toEqual([]);
  });

  it("Phase 10-10A: 人物/ポートレート dropped alongside other kept tags", () => {
    const out = refineTagCandidates([{ label: "人物" }, { label: "海" }, { label: "ポートレート" }, { label: "朝" }]);
    expect(out.map((t) => t.label)).toEqual(["朝", "海"]);
  });

  it("Phase 10-10A: normalizes English time-of-day terms into the refined output", () => {
    const out = refineTagCandidates([
      { label: "sunset" },
      { label: "dusk" },
      { label: "twilight" },
      { label: "golden hour" },
      { label: "evening" },
    ]);
    // all collapse to the single canonical 夕方 (dedupe)
    expect(out.map((t) => t.label)).toEqual(["夕方"]);
  });

  it("Phase 10-10A: night/morning/daytime English terms normalize correctly", () => {
    expect(refineTagCandidates([{ label: "night" }]).map((t) => t.label)).toEqual(["夜"]);
    expect(refineTagCandidates([{ label: "nighttime" }]).map((t) => t.label)).toEqual(["夜"]);
    expect(refineTagCandidates([{ label: "morning" }]).map((t) => t.label)).toEqual(["朝"]);
    expect(refineTagCandidates([{ label: "sunrise" }]).map((t) => t.label)).toEqual(["朝"]);
    expect(refineTagCandidates([{ label: "daytime" }]).map((t) => t.label)).toEqual(["昼"]);
    expect(refineTagCandidates([{ label: "noon" }]).map((t) => t.label)).toEqual(["昼"]);
    expect(refineTagCandidates([{ label: "afternoon" }]).map((t) => t.label)).toEqual(["昼"]);
  });

  it("limits mood tags to at most 1", () => {
    const out = refineTagCandidates([
      { label: "ナチュラル" },
      { label: "シンプル" },
      { label: "高級感" },
    ]);
    expect(out.filter((t) => getTagCategory(t.label) === "mood")).toHaveLength(1);
    expect(out[0].label).toBe("ナチュラル"); // first mood kept
  });

  it("caps total to 8 tags", () => {
    const many = [
      "朝", "水着", "海", "全身", "自然光", "風景", "料理", "商品", "建物", "小物",
    ].map((label) => ({ label }));
    const out = refineTagCandidates(many);
    expect(out).toHaveLength(8);
  });

  it("sorts by category priority: time → outfit → place → composition → light → subject → mood", () => {
    const out = refineTagCandidates([
      { label: "高級感" }, // mood
      { label: "風景" }, // subject
      { label: "自然光" }, // light
      { label: "全身" }, // composition
      { label: "海" }, // place
      { label: "水着" }, // outfit
      { label: "朝" }, // time
    ]);
    expect(out.map((t) => t.label)).toEqual([
      "朝",
      "水着",
      "海",
      "全身",
      "自然光",
      "風景",
      "高級感",
    ]);
  });

  it("preserves confidence when present", () => {
    const out = refineTagCandidates([{ label: "海", confidence: 0.9 }]);
    expect(out).toEqual([{ label: "海", confidence: 0.9 }]);
  });
});
