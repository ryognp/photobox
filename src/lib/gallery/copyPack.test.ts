import { describe, it, expect } from "vitest"
import {
  joinLabels,
  getEffectivePromptJapaneseText,
  buildPromptCopyText,
  buildImageDetailCopyText,
} from "@/lib/gallery/copyPack"
import type { ImageDetail } from "@/lib/gallery/imagesClient"

function makeDetail(over: Partial<ImageDetail> = {}): ImageDetail {
  return {
    id: "img-1",
    originalName: "xxx.jpg",
    originalExt: "jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 1,
    widthPx: null,
    heightPx: null,
    fileHashSnippet: null,
    isFavorite: false,
    rating: null,
    notes: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    sourceSheetName: null,
    sourceRow: null,
    sourceColumn: null,
    importBatchId: null,
    scene: null,
    tags: [],
    persons: [],
    tagSuggestions: [],
    prompt: null,
    signedUrls: { thumbnailUrl: null, previewUrl: null, originalUrl: null },
    translationEnabled: false,
    variationEnabled: false,
    ...over,
  }
}

function makePrompt(over: Partial<NonNullable<ImageDetail["prompt"]>> = {}): NonNullable<ImageDetail["prompt"]> {
  return {
    id: "p1",
    currentBody: "a woman on a beach at sunset",
    originalBody: "a woman on a beach at sunset",
    createdAt: "2026-07-12T00:00:00.000Z",
    versions: [],
    translatedBodyJa: null,
    translatedFromBodyHash: null,
    translationStatus: "NONE",
    translationProvider: null,
    translationModel: null,
    translatedAt: null,
    translationStartedAt: null,
    translationError: null,
    effectiveTranslatedBodyJa: null,
    ...over,
  }
}

describe("joinLabels", () => {
  it("joins with ', '", () => {
    expect(joinLabels(["水着", "夕方", "海"])).toBe("水着, 夕方, 海")
  })
  it("empty array → empty string", () => {
    expect(joinLabels([])).toBe("")
  })
  it("single label → no separator", () => {
    expect(joinLabels(["海"])).toBe("海")
  })
})

describe("getEffectivePromptJapaneseText", () => {
  it("returns the effective JA text when present and non-blank", () => {
    const detail = makeDetail({ prompt: makePrompt({ effectiveTranslatedBodyJa: "夕暮れの海辺に立つ女性" }) })
    expect(getEffectivePromptJapaneseText(detail)).toBe("夕暮れの海辺に立つ女性")
  })
  it("returns null when effectiveTranslatedBodyJa is null", () => {
    expect(getEffectivePromptJapaneseText(makeDetail({ prompt: makePrompt() }))).toBeNull()
  })
  it("returns null when effectiveTranslatedBodyJa is blank/whitespace", () => {
    expect(getEffectivePromptJapaneseText(makeDetail({ prompt: makePrompt({ effectiveTranslatedBodyJa: "   " }) }))).toBeNull()
  })
  it("returns null when there is no prompt at all", () => {
    expect(getEffectivePromptJapaneseText(makeDetail({ prompt: null }))).toBeNull()
  })
})

describe("buildPromptCopyText", () => {
  it("returns currentBody when present", () => {
    const detail = makeDetail({ prompt: makePrompt({ currentBody: "a cat" }) })
    expect(buildPromptCopyText(detail)).toBe("a cat")
  })
  it("returns null when there is no prompt", () => {
    expect(buildPromptCopyText(makeDetail({ prompt: null }))).toBeNull()
  })
  it("returns null when currentBody is blank", () => {
    expect(buildPromptCopyText(makeDetail({ prompt: makePrompt({ currentBody: "   " }) }))).toBeNull()
  })
})

describe("buildImageDetailCopyText", () => {
  it("full case: fileName + tags + suggestions + JA + prompt, in order", () => {
    const detail = makeDetail({
      originalName: "beach.jpg",
      scene: { id: "s1", name: "海" },
      tags: [{ id: "t1", name: "水着" }, { id: "t2", name: "夕方" }],
      tagSuggestions: [{ id: "sg1", label: "プール", confidence: 0.8, status: "PENDING" }],
      prompt: makePrompt({ currentBody: "a woman on a beach", effectiveTranslatedBodyJa: "海辺に立つ女性" }),
    })
    expect(buildImageDetailCopyText(detail)).toBe(
      [
        "【ファイル名】\nbeach.jpg",
        "【タグ】\n水着, 夕方",
        "【AI候補タグ】\nプール",
        "【日本語訳】\n海辺に立つ女性",
        "【Prompt】\na woman on a beach",
      ].join("\n\n"),
    )
  })

  it("minimal case: only fileName (tags/suggestions/JA/prompt all absent)", () => {
    const detail = makeDetail({ originalName: "solo.jpg" })
    expect(buildImageDetailCopyText(detail)).toBe("【ファイル名】\nsolo.jpg")
  })

  it("Phase 10-14A: never renders 【シーン】, even when scene is present", () => {
    const detail = makeDetail({ scene: { id: "s1", name: "海" }, prompt: makePrompt() })
    expect(buildImageDetailCopyText(detail)).not.toContain("【シーン】")
    expect(buildImageDetailCopyText(detail)).not.toContain("シーン")
  })

  it("omits 【タグ】 when tags is empty", () => {
    const detail = makeDetail({ tags: [] })
    expect(buildImageDetailCopyText(detail)).not.toContain("【タグ】")
  })

  it("omits 【AI候補タグ】 when tagSuggestions is empty", () => {
    const detail = makeDetail({ tagSuggestions: [] })
    expect(buildImageDetailCopyText(detail)).not.toContain("【AI候補タグ】")
  })

  it("includes 【タグ】 and 【AI候補タグ】 as separate sections when both present", () => {
    const detail = makeDetail({
      tags: [{ id: "t1", name: "海" }],
      tagSuggestions: [{ id: "sg1", label: "プール", confidence: null, status: "PENDING" }],
    })
    const text = buildImageDetailCopyText(detail)
    expect(text).toContain("【タグ】\n海")
    expect(text).toContain("【AI候補タグ】\nプール")
  })

  it("omits 【日本語訳】 when there is no effective translation", () => {
    const detail = makeDetail({ prompt: makePrompt({ effectiveTranslatedBodyJa: null }) })
    expect(buildImageDetailCopyText(detail)).not.toContain("【日本語訳】")
  })

  it("omits 【Prompt】 when there is no prompt", () => {
    const detail = makeDetail({ prompt: null })
    expect(buildImageDetailCopyText(detail)).not.toContain("【Prompt】")
  })

  it("does not render 'ok未設定' placeholders for missing sections", () => {
    const detail = makeDetail()
    expect(buildImageDetailCopyText(detail)).not.toContain("未設定")
  })
})
