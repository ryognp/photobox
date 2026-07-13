import { describe, it, expect } from "vitest";
import {
  formatBulkTagSuccessMessage,
  formatBulkPersonSuccessMessage,
} from "@/lib/gallery/bulkActionMessage";

describe("formatBulkTagSuccessMessage", () => {
  it("shows both new and already-linked counts", () => {
    expect(
      formatBulkTagSuccessMessage("海", { targetCount: 10, createdLinkCount: 8, alreadyLinkedCount: 2 }),
    ).toBe("タグ「海」を10枚に追加しました（新規8件、既存2件）");
  });

  it("shows only createdLinkCount when alreadyLinkedCount is 0", () => {
    expect(
      formatBulkTagSuccessMessage("海", { targetCount: 5, createdLinkCount: 5, alreadyLinkedCount: 0 }),
    ).toBe("タグ「海」を5枚に追加しました（新規5件）");
  });

  it("shows only alreadyLinkedCount when createdLinkCount is 0 (idempotent re-send)", () => {
    expect(
      formatBulkTagSuccessMessage("海", { targetCount: 5, createdLinkCount: 0, alreadyLinkedCount: 5 }),
    ).toBe("タグ「海」を5枚に追加しました（既存5件）");
  });

  it("omits the parenthetical entirely when both counts are 0 (targetCount 0 edge case)", () => {
    expect(
      formatBulkTagSuccessMessage("海", { targetCount: 0, createdLinkCount: 0, alreadyLinkedCount: 0 }),
    ).toBe("タグ「海」を0枚に追加しました");
  });
});

describe("formatBulkPersonSuccessMessage", () => {
  it("shows both new and already-linked counts", () => {
    expect(
      formatBulkPersonSuccessMessage("凛", { targetCount: 5, createdLinkCount: 5, alreadyLinkedCount: 0 }),
    ).toBe("人物「凛」を5枚に追加しました（新規5件）");
  });

  it("shows only alreadyLinkedCount for a fully idempotent re-send", () => {
    expect(
      formatBulkPersonSuccessMessage("凛", { targetCount: 3, createdLinkCount: 0, alreadyLinkedCount: 3 }),
    ).toBe("人物「凛」を3枚に追加しました（既存3件）");
  });

  it("shows a mixed new/existing split", () => {
    expect(
      formatBulkPersonSuccessMessage("凛", { targetCount: 4, createdLinkCount: 1, alreadyLinkedCount: 3 }),
    ).toBe("人物「凛」を4枚に追加しました（新規1件、既存3件）");
  });
});
