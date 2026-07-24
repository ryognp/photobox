import { describe, it, expect } from "vitest";
import {
  isPromptDirty,
  isMetadataDirty,
  canonicalizeMetadata,
  canAdvanceAfterSave,
  derivePromptStatus,
  parsePromptStatus,
  type MetadataFields,
  type PromptFields,
  type PromptStatusValue,
} from "@/lib/quick-add/itemDirty";

const BASE_META: MetadataFields = {
  sceneId: "scene-1",
  tagIds: ["tag-a", "tag-b"],
  personIds: ["person-1"],
  rating: 3,
  isFavorite: false,
  notes: "memo",
};

// PromptFields の短縮ヘルパー(status未指定は DRAFT)
function p(promptDraft: string, promptStatus: PromptStatusValue = "DRAFT"): PromptFields {
  return { promptDraft, promptStatus };
}

describe("isPromptDirty", () => {
  it("初期値と現在値が同じならclean", () => {
    expect(isPromptDirty(p("hello"), p("hello"))).toBe(false);
  });

  it("プロンプト変更でdirty", () => {
    expect(isPromptDirty(p("hello!"), p("hello"))).toBe(true);
  });
});

describe("isPromptDirty (promptStatus intent)", () => {
  it("promptDraftとpromptStatusが両方同じならclean", () => {
    expect(isPromptDirty(p("hello", "FILLED"), p("hello", "FILLED"))).toBe(false);
    expect(isPromptDirty(p("", "EMPTY"), p("", "EMPTY"))).toBe(false);
  });

  it("promptDraftが同じでもDRAFT→FILLEDならdirty", () => {
    expect(isPromptDirty(p("hello", "FILLED"), p("hello", "DRAFT"))).toBe(true);
  });

  it("promptDraftが同じでもFILLED→DRAFTならdirty", () => {
    expect(isPromptDirty(p("hello", "DRAFT"), p("hello", "FILLED"))).toBe(true);
  });

  it("promptDraftが同じでもDRAFT→EMPTYならdirty", () => {
    expect(isPromptDirty(p("", "EMPTY"), p("", "DRAFT"))).toBe(true);
  });

  it("前後空白だけが異なりstatusが同じならclean", () => {
    expect(isPromptDirty(p("  hello  ", "DRAFT"), p("hello", "DRAFT"))).toBe(false);
  });

  it("前後空白だけが同値でもstatusが異なればdirty", () => {
    expect(isPromptDirty(p("  hello  ", "FILLED"), p("hello", "DRAFT"))).toBe(true);
  });
});

describe("derivePromptStatus", () => {
  it("draft+本文ありからDRAFTを導出できる", () => {
    expect(derivePromptStatus("hello", "draft")).toBe("DRAFT");
    expect(derivePromptStatus("  hello  ", "draft")).toBe("DRAFT");
  });

  it("draft+空本文からEMPTYを導出できる", () => {
    expect(derivePromptStatus("", "draft")).toBe("EMPTY");
    expect(derivePromptStatus("   ", "draft")).toBe("EMPTY");
  });

  it("filled+本文ありからFILLEDを導出できる", () => {
    expect(derivePromptStatus("hello", "filled")).toBe("FILLED");
    expect(derivePromptStatus("  hello  ", "filled")).toBe("FILLED");
  });
});

describe("parsePromptStatus", () => {
  it("正常な3値はそのまま返す", () => {
    expect(parsePromptStatus("EMPTY")).toBe("EMPTY");
    expect(parsePromptStatus("DRAFT")).toBe("DRAFT");
    expect(parsePromptStatus("FILLED")).toBe("FILLED");
  });

  it("欠落・未知値はfallback(既定EMPTY)を返す", () => {
    expect(parsePromptStatus(undefined)).toBe("EMPTY");
    expect(parsePromptStatus(null)).toBe("EMPTY");
    expect(parsePromptStatus("filled")).toBe("EMPTY");
    expect(parsePromptStatus(undefined, "FILLED")).toBe("FILLED");
  });
});

describe("isMetadataDirty", () => {
  it("初期値と現在値が同じならclean", () => {
    expect(isMetadataDirty({ ...BASE_META }, BASE_META)).toBe(false);
  });

  it("タグの並び順だけが変わってもclean", () => {
    const current: MetadataFields = { ...BASE_META, tagIds: ["tag-b", "tag-a"] };
    expect(isMetadataDirty(current, BASE_META)).toBe(false);
  });

  it("人物の並び順だけが変わってもclean", () => {
    const base: MetadataFields = { ...BASE_META, personIds: ["person-1", "person-2"] };
    const current: MetadataFields = { ...base, personIds: ["person-2", "person-1"] };
    expect(isMetadataDirty(current, base)).toBe(false);
  });

  it("タグの内容が変わればdirty", () => {
    const current: MetadataFields = { ...BASE_META, tagIds: ["tag-a", "tag-c"] };
    expect(isMetadataDirty(current, BASE_META)).toBe(true);
  });

  it("人物の内容が変わればdirty", () => {
    const current: MetadataFields = { ...BASE_META, personIds: ["person-2"] };
    expect(isMetadataDirty(current, BASE_META)).toBe(true);
  });

  it("評価の変更でdirty", () => {
    expect(isMetadataDirty({ ...BASE_META, rating: 5 }, BASE_META)).toBe(true);
  });

  it("お気に入りの変更でdirty", () => {
    expect(isMetadataDirty({ ...BASE_META, isFavorite: true }, BASE_META)).toBe(true);
  });

  it("シーンの変更でdirty", () => {
    expect(isMetadataDirty({ ...BASE_META, sceneId: "scene-2" }, BASE_META)).toBe(true);
  });

  it("メモの変更でdirty", () => {
    expect(isMetadataDirty({ ...BASE_META, notes: "memo!" }, BASE_META)).toBe(true);
  });
});

describe("canonical化 (サーバー保存値と同じ意味での比較)", () => {
  it("プロンプトの前後空白だけが異なる場合はclean", () => {
    expect(isPromptDirty(p("  hello  "), p("hello"))).toBe(false);
  });

  it("プロンプトが空白のみの場合、空文字baselineとclean", () => {
    expect(isPromptDirty(p("   ", "EMPTY"), p("", "EMPTY"))).toBe(false);
  });

  it("メモの前後空白だけが異なる場合はclean", () => {
    expect(isMetadataDirty({ ...BASE_META, notes: "  memo  " }, BASE_META)).toBe(false);
  });

  it("メモが空白のみの場合、空文字baselineとclean", () => {
    const base: MetadataFields = { ...BASE_META, notes: "" };
    expect(isMetadataDirty({ ...base, notes: "   " }, base)).toBe(false);
  });

  it("canonical化後も実際の本文変更はdirty", () => {
    expect(isPromptDirty(p("  hello world  "), p("hello"))).toBe(true);
    expect(isMetadataDirty({ ...BASE_META, notes: "  memo2  " }, BASE_META)).toBe(true);
  });

  it("canonical化してもタグ・人物の順序無視は維持される", () => {
    const current: MetadataFields = {
      ...BASE_META,
      tagIds: ["tag-b", "tag-a"],
      notes: "  memo  ",
    };
    expect(isMetadataDirty(current, BASE_META)).toBe(false);
  });

  it("canonicalizeMetadataのtagIds/personIdsは元配列の後続変更から独立している", () => {
    const original: MetadataFields = { ...BASE_META, tagIds: ["tag-a"], personIds: ["person-1"] };
    const snapshot = canonicalizeMetadata(original);
    original.tagIds.push("tag-x");
    original.personIds.push("person-x");
    expect(snapshot.tagIds).toEqual(["tag-a"]);
    expect(snapshot.personIds).toEqual(["person-1"]);
  });
});

describe("canAdvanceAfterSave (保存中に編集された場合のadvance判定)", () => {
  const savedPrompt: PromptFields = p("saved text", "FILLED");
  const savedMeta: MetadataFields = { ...BASE_META };

  it("保存後の最新値がsnapshotと一致すればadvance可能", () => {
    expect(
      canAdvanceAfterSave({
        currentPrompt: p("saved text", "FILLED"),
        savedPrompt,
        currentMetadata: { ...BASE_META },
        savedMetadata: savedMeta,
      }),
    ).toBe(true);
  });

  it("保存中にプロンプトが変わればadvance不可", () => {
    expect(
      canAdvanceAfterSave({
        currentPrompt: p("saved text + edited during save", "FILLED"),
        savedPrompt,
        currentMetadata: { ...BASE_META },
        savedMetadata: savedMeta,
      }),
    ).toBe(false);
  });

  it("本文が同じでもstatusが違えばadvance不可", () => {
    expect(
      canAdvanceAfterSave({
        currentPrompt: p("saved text", "DRAFT"),
        savedPrompt,
        currentMetadata: { ...BASE_META },
        savedMetadata: savedMeta,
      }),
    ).toBe(false);
  });

  it("本文・status・metadataが全て一致すればadvance可能", () => {
    expect(
      canAdvanceAfterSave({
        currentPrompt: p("saved text", "FILLED"),
        savedPrompt,
        currentMetadata: { ...BASE_META, tagIds: [...BASE_META.tagIds] },
        savedMetadata: savedMeta,
      }),
    ).toBe(true);
  });

  it("保存中にタグが変わればadvance不可", () => {
    expect(
      canAdvanceAfterSave({
        currentPrompt: p("saved text", "FILLED"),
        savedPrompt,
        currentMetadata: { ...BASE_META, tagIds: ["tag-a", "tag-b", "tag-new"] },
        savedMetadata: savedMeta,
      }),
    ).toBe(false);
  });

  it("保存中に人物・シーン・評価・お気に入り・メモのいずれかが変わればadvance不可", () => {
    const cases: Array<Partial<MetadataFields>> = [
      { personIds: ["person-1", "person-2"] },
      { sceneId: "scene-2" },
      { rating: 5 },
      { isFavorite: true },
      { notes: "edited during save" },
    ];
    for (const patch of cases) {
      expect(
        canAdvanceAfterSave({
          currentPrompt: p("saved text", "FILLED"),
          savedPrompt,
          currentMetadata: { ...BASE_META, ...patch },
          savedMetadata: savedMeta,
        }),
      ).toBe(false);
    }
  });

  it("保存中に変更後、元のcanonical値へ戻した場合はadvance可能(空白差・statusも同じ)", () => {
    // 前後空白の付与・タグの並び替えは canonical 上は同一値なので advance してよい
    expect(
      canAdvanceAfterSave({
        currentPrompt: p("  saved text  ", "FILLED"),
        savedPrompt,
        currentMetadata: { ...BASE_META, tagIds: ["tag-b", "tag-a"], notes: " memo " },
        savedMetadata: savedMeta,
      }),
    ).toBe(true);
  });
});

describe("組み合わせシナリオ(保存成功時のbaseline更新を想定)", () => {
  it("メタデータ保存成功後も、未保存プロンプトがあればdirty", () => {
    // メタデータは保存成功して baseline が更新された(=現在値と一致)想定
    const metaDirty = isMetadataDirty(BASE_META, BASE_META);
    // プロンプトは未保存のまま(baseline と現在値が異なる)
    const promptDirty = isPromptDirty(p("未保存の続き", "EMPTY"), p("", "EMPTY"));
    expect(metaDirty).toBe(false);
    expect(promptDirty).toBe(true);
    expect(metaDirty || promptDirty).toBe(true);
  });

  it("メタデータ成功・プロンプト失敗時、プロンプトのdirtyが残る", () => {
    // メタデータ保存成功 → baseline はメタデータの送信snapshotと一致
    const metaCurrent: MetadataFields = { ...BASE_META, tagIds: ["tag-a", "tag-b", "tag-c"] };
    const metaBaselineAfterSuccess = canonicalizeMetadata(metaCurrent);
    // プロンプトは保存に失敗したため、baseline は更新されず古いまま
    const promptBaselineBeforeFailedSave = p("元の文章");
    const promptCurrent = p("編集後の文章");

    expect(isMetadataDirty(metaCurrent, metaBaselineAfterSuccess)).toBe(false);
    expect(isPromptDirty(promptCurrent, promptBaselineBeforeFailedSave)).toBe(true);
  });

  it("メタデータ成功・プロンプト失敗・本文変更なし・DRAFT→FILLED intentでdirtyが残る", () => {
    // DRAFT保存済みの本文を変更せず「入力済みにする」→ prompt APIだけ失敗した状況。
    // baseline は DRAFT のまま、current の status intent は FILLED。
    const baseline = p("abc", "DRAFT");
    const currentAfterFailedSave = p("abc", derivePromptStatus("abc", "filled"));
    expect(isPromptDirty(currentAfterFailedSave, baseline)).toBe(true);
  });

  it("メタデータ成功・プロンプト失敗・本文変更なし・FILLED→DRAFT intentでdirtyが残る", () => {
    // FILLED保存済みの本文を変更せず「下書き保存」→ prompt APIだけ失敗した状況。
    const baseline = p("abc", "FILLED");
    const currentAfterFailedSave = p("abc", derivePromptStatus("abc", "draft"));
    expect(isPromptDirty(currentAfterFailedSave, baseline)).toBe(true);
  });

  it("要求statusが既存baselineと同じ場合、本文も同じなら通信失敗だけでdirtyにならない", () => {
    // 既にFILLEDのアイテムを同じ本文で再度FILLED保存し、通信だけ失敗したケース。
    const baseline = p("abc", "FILLED");
    const currentAfterFailedSave = p("abc", derivePromptStatus("abc", "filled"));
    expect(isPromptDirty(currentAfterFailedSave, baseline)).toBe(false);
  });

  it("prompt保存成功後、本文とstatusのbaselineが更新されcleanになる", () => {
    // 保存成功 → baseline は送信snapshot(canonical本文+要求status)そのもの
    const savedSnapshot = p("abc", derivePromptStatus("abc", "filled"));
    const currentAfterSuccess = p("abc", "FILLED");
    expect(isPromptDirty(currentAfterSuccess, savedSnapshot)).toBe(false);
  });

  it("リクエスト中に変更された値は、誤って保存済み扱いにならない", () => {
    // リクエスト開始時点のスナップショットが baseline になるべきで、
    // 通信完了時点の最新UI値を baseline にしてはいけない。
    const snapshotAtRequestStart: MetadataFields = canonicalizeMetadata(BASE_META);
    // 通信中にユーザーがタグを追加した(最新UI値)
    const latestUiValueAtCompletion: MetadataFields = {
      ...BASE_META,
      tagIds: [...BASE_META.tagIds, "tag-added-during-request"],
    };

    // 誤り: 完了時点の最新値を baseline にしてしまうと dirty が消えてしまう
    expect(isMetadataDirty(latestUiValueAtCompletion, latestUiValueAtCompletion)).toBe(false);

    // 正しい: baseline はリクエスト開始時点のスナップショットのままなので、
    // 通信完了後も最新UI値との比較では dirty が残る。
    expect(isMetadataDirty(latestUiValueAtCompletion, snapshotAtRequestStart)).toBe(true);
  });
});
