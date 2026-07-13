import { describe, it, expect } from "vitest";
import {
  normalizeTagLabel,
  isBannedTagLabel,
  isExcludedGenericLabel,
  isExcludedLowValueLabel,
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
  });

  it("Phase 10-10B: 'golden hour' alone is NOT normalized to 夕方 (ambiguous — used for both sunrise and sunset)", () => {
    expect(normalizeTagLabel("golden hour")).toBe("golden hour");
    expect(normalizeTagLabel("Golden Hour")).toBe("Golden Hour"); // identity, no case-fold match either
  });

  it("Phase 10-10B: morning-qualified phrases normalize to 朝", () => {
    expect(normalizeTagLabel("early morning")).toBe("朝");
    expect(normalizeTagLabel("morning light")).toBe("朝");
    expect(normalizeTagLabel("sunrise light")).toBe("朝");
  });

  it("Phase 10-10B: bare light-quality words are NOT normalized to any time-of-day label", () => {
    for (const t of ["warm light", "golden light", "soft light", "natural light"]) {
      expect(normalizeTagLabel(t)).toBe(t); // identity — no synonym entry
    }
  });

  it("Phase 10-13C: no synonym normalizes to any removed label (私服/室内/屋外/自然光/ナチュラル/シンプル/リラックス)", () => {
    // English surface forms that MIGHT plausibly have been mapped to a removed
    // label are NOT in SYNONYM_MAP — they pass through as identity (which
    // means refineTagCandidates then drops them as out-of-vocabulary).
    for (const t of ["casual", "indoor", "indoors", "outdoor", "outdoors", "natural", "simple", "relaxed"]) {
      expect(normalizeTagLabel(t)).toBe(t);
    }
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
    for (const t of ["海", "夕方", "水着", "逆光", "高級感", "夕景"]) {
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
    for (const t of ["海", "夕方", "水着", "逆光", "高級感", "風景", "建物", "犬", "猫"]) {
      expect(isExcludedGenericLabel(t)).toBe(false);
    }
  });
  it("does not flag Phase 10-13C low-value labels (separate layer)", () => {
    for (const t of ["自然光", "ナチュラル", "シンプル", "室内", "屋外", "私服", "リラックス"]) {
      expect(isExcludedGenericLabel(t)).toBe(false);
    }
  });
});

describe("isExcludedLowValueLabel (Phase 10-13C)", () => {
  it("flags all 7 removed generic/abstract/low-value labels", () => {
    for (const t of ["自然光", "ナチュラル", "シンプル", "室内", "屋外", "私服", "リラックス"]) {
      expect(isExcludedLowValueLabel(t)).toBe(true);
    }
  });
  it("trims before matching", () => {
    expect(isExcludedLowValueLabel("  自然光 ")).toBe(true);
  });
  it("does not flag remaining controlled-vocabulary words", () => {
    for (const t of ["部屋", "ホテル", "スタジオ", "カフェ", "海", "プール", "ビーチ", "ドレス", "スーツ", "制服", "和装", "部屋着", "コート", "逆光", "高級感", "クール"]) {
      expect(isExcludedLowValueLabel(t)).toBe(false);
    }
  });
  it("is a separate layer from isExcludedGenericLabel (人物/ポートレート)", () => {
    expect(isExcludedLowValueLabel("人物")).toBe(false);
    expect(isExcludedLowValueLabel("ポートレート")).toBe(false);
  });
});

describe("getTagCategory", () => {
  it("returns the category for vocabulary words", () => {
    expect(getTagCategory("朝")).toBe("time");
    expect(getTagCategory("水着")).toBe("outfit");
    expect(getTagCategory("海")).toBe("place");
    expect(getTagCategory("全身")).toBe("composition");
    expect(getTagCategory("逆光")).toBe("light");
    expect(getTagCategory("風景")).toBe("subject");
    expect(getTagCategory("高級感")).toBe("mood");
  });

  it("Phase 10-10A: 人物 and ポートレート are no longer in the controlled vocabulary", () => {
    expect(getTagCategory("人物")).toBeUndefined();
    expect(getTagCategory("ポートレート")).toBeUndefined();
  });

  it("Phase 10-13C: removed low-value labels are no longer in the controlled vocabulary", () => {
    for (const t of ["自然光", "ナチュラル", "シンプル", "室内", "屋外", "私服", "リラックス"]) {
      expect(getTagCategory(t)).toBeUndefined();
    }
  });

  it("Phase 10-13C: 部屋 (specific place) remains categorized, unlike removed 室内/屋外", () => {
    expect(getTagCategory("部屋")).toBe("place");
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
      { label: "evening" },
    ]);
    // all collapse to the single canonical 夕方 (dedupe)
    expect(out.map((t) => t.label)).toEqual(["夕方"]);
  });

  it("Phase 10-10B: bare 'golden hour' yields NO time-of-day tag (ambiguous)", () => {
    expect(refineTagCandidates([{ label: "golden hour" }])).toEqual([]);
  });

  it("Phase 10-10B: morning-qualified phrases normalize to 朝 in the refined output", () => {
    expect(refineTagCandidates([{ label: "early morning" }]).map((t) => t.label)).toEqual(["朝"]);
    expect(refineTagCandidates([{ label: "morning light" }]).map((t) => t.label)).toEqual(["朝"]);
    expect(refineTagCandidates([{ label: "sunrise light" }]).map((t) => t.label)).toEqual(["朝"]);
  });

  it("Phase 10-10B: bare light-quality words never yield a time-of-day tag", () => {
    for (const t of ["warm light", "golden light", "soft light", "natural light"]) {
      expect(refineTagCandidates([{ label: t }])).toEqual([]);
    }
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

  // Phase 10-13C: removed generic/abstract/low-value labels are dropped even
  // when the provider still returns them (real-world provider drift, cached
  // prompts, etc.) — refineTagCandidates is the mechanical backstop.
  it("Phase 10-13C: drops 自然光", () => {
    expect(refineTagCandidates([{ label: "自然光" }])).toEqual([]);
  });
  it("Phase 10-13C: drops ナチュラル", () => {
    expect(refineTagCandidates([{ label: "ナチュラル" }])).toEqual([]);
  });
  it("Phase 10-13C: drops シンプル", () => {
    expect(refineTagCandidates([{ label: "シンプル" }])).toEqual([]);
  });
  it("Phase 10-13C: drops 室内", () => {
    expect(refineTagCandidates([{ label: "室内" }])).toEqual([]);
  });
  it("Phase 10-13C: drops 屋外", () => {
    expect(refineTagCandidates([{ label: "屋外" }])).toEqual([]);
  });
  it("Phase 10-13C: drops 私服", () => {
    expect(refineTagCandidates([{ label: "私服" }])).toEqual([]);
  });
  it("Phase 10-13C: drops リラックス", () => {
    expect(refineTagCandidates([{ label: "リラックス" }])).toEqual([]);
  });

  it("Phase 10-13C: removed labels dropped alongside other kept tags", () => {
    const out = refineTagCandidates([
      { label: "自然光" },
      { label: "海" },
      { label: "私服" },
      { label: "ドレス" },
      { label: "室内" },
      { label: "部屋" },
    ]);
    expect(out.map((t) => t.label)).toEqual(["ドレス", "海", "部屋"]);
  });

  it("Phase 10-13C: no synonym path resurrects a removed label", () => {
    // English surface forms pass through normalizeTagLabel as identity (no
    // synonym entry), so they are then dropped as out-of-vocabulary — never
    // resolved to a removed JA label.
    for (const t of ["casual", "indoor", "indoors", "outdoor", "outdoors", "natural", "simple", "relaxed"]) {
      expect(refineTagCandidates([{ label: t }])).toEqual([]);
    }
  });

  it("Phase 10-13C: specific place/outfit/mood labels still survive refinement", () => {
    const out = refineTagCandidates([
      { label: "部屋" },
      { label: "ホテル" },
      { label: "スタジオ" },
      { label: "カフェ" },
      { label: "海" },
      { label: "プール" },
      { label: "ビーチ" },
      { label: "ドレス" },
      { label: "スーツ" },
      { label: "制服" },
      { label: "和装" },
      { label: "部屋着" },
      { label: "コート" },
    ]);
    // total cap is 8 — assert the first 8 in priority-sorted order all survive
    // (outfit before place per CATEGORY_PRIORITY), none silently dropped as
    // "removed".
    expect(out).toHaveLength(8);
    for (const label of ["ドレス", "スーツ", "制服", "和装", "部屋着", "コート", "部屋", "ホテル"]) {
      expect(out.map((t) => t.label)).toContain(label);
    }
  });

  it("limits mood tags to at most 1 (using the remaining mood vocabulary)", () => {
    const out = refineTagCandidates([
      { label: "高級感" },
      { label: "クール" },
    ]);
    expect(out.filter((t) => getTagCategory(t.label) === "mood")).toHaveLength(1);
    expect(out[0].label).toBe("高級感"); // first mood kept
  });

  it("caps total to 8 tags", () => {
    const many = [
      "朝", "水着", "海", "全身", "逆光", "風景", "料理", "商品", "建物", "小物",
    ].map((label) => ({ label }));
    const out = refineTagCandidates(many);
    expect(out).toHaveLength(8);
  });

  it("sorts by category priority: time → outfit → place → composition → light → subject → mood", () => {
    const out = refineTagCandidates([
      { label: "高級感" }, // mood
      { label: "風景" }, // subject
      { label: "逆光" }, // light
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
      "逆光",
      "風景",
      "高級感",
    ]);
  });

  it("preserves confidence when present", () => {
    const out = refineTagCandidates([{ label: "海", confidence: 0.9 }]);
    expect(out).toEqual([{ label: "海", confidence: 0.9 }]);
  });
});
