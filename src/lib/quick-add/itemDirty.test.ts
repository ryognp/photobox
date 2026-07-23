import { describe, it, expect } from "vitest";
import { isPromptDirty, isMetadataDirty, type MetadataFields } from "@/lib/quick-add/itemDirty";

const BASE_META: MetadataFields = {
  sceneId: "scene-1",
  tagIds: ["tag-a", "tag-b"],
  personIds: ["person-1"],
  rating: 3,
  isFavorite: false,
  notes: "memo",
};

describe("isPromptDirty", () => {
  it("初期値と現在値が同じならclean", () => {
    expect(isPromptDirty({ promptDraft: "hello" }, { promptDraft: "hello" })).toBe(false);
  });

  it("プロンプト変更でdirty", () => {
    expect(isPromptDirty({ promptDraft: "hello!" }, { promptDraft: "hello" })).toBe(true);
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

describe("組み合わせシナリオ(メタデータ保存成功後の baseline 更新を想定)", () => {
  it("メタデータ保存成功後も、未保存プロンプトがあればdirty", () => {
    // メタデータは保存成功して baseline が更新された(=現在値と一致)想定
    const metaDirty = isMetadataDirty(BASE_META, BASE_META);
    // プロンプトは未保存のまま(baseline と現在値が異なる)
    const promptDirty = isPromptDirty({ promptDraft: "未保存の続き" }, { promptDraft: "" });
    expect(metaDirty).toBe(false);
    expect(promptDirty).toBe(true);
    expect(metaDirty || promptDirty).toBe(true);
  });

  it("メタデータ成功・プロンプト失敗時、プロンプトのdirtyが残る", () => {
    // メタデータ保存成功 → baseline はメタデータの現在値と一致
    const metaCurrent: MetadataFields = { ...BASE_META, tagIds: ["tag-a", "tag-b", "tag-c"] };
    const metaBaselineAfterSuccess = metaCurrent; // 保存成功時、baselineはsnapshotそのもの
    // プロンプトは保存に失敗したため、baseline は更新されず古いまま
    const promptBaselineBeforeFailedSave = { promptDraft: "元の文章" };
    const promptCurrent = { promptDraft: "編集後の文章" };

    expect(isMetadataDirty(metaCurrent, metaBaselineAfterSuccess)).toBe(false);
    expect(isPromptDirty(promptCurrent, promptBaselineBeforeFailedSave)).toBe(true);
  });

  it("リクエスト中に変更された値は、誤って保存済み扱いにならない", () => {
    // リクエスト開始時点のスナップショットが baseline になるべきで、
    // 通信完了時点の最新UI値を baseline にしてはいけない。
    const snapshotAtRequestStart: MetadataFields = { ...BASE_META };
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
