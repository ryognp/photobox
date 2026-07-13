import { describe, it, expect } from "vitest";
import { formatTagForceDeleteConfirmMessage } from "@/lib/masters/tagDeleteMessage";

describe("formatTagForceDeleteConfirmMessage", () => {
  it("includes the tag name and image count", () => {
    expect(formatTagForceDeleteConfirmMessage("海", 10)).toBe(
      "「海」を画像から完全に外して削除します。10枚の画像からこのタグの紐づけが解除されます（画像自体は削除されません）。元に戻せません。",
    );
  });

  it("works for a single linked image", () => {
    const msg = formatTagForceDeleteConfirmMessage("プール", 1);
    expect(msg).toContain("「プール」");
    expect(msg).toContain("1枚の画像");
  });

  it("never mentions deleting the image itself", () => {
    const msg = formatTagForceDeleteConfirmMessage("海", 5);
    expect(msg).toContain("画像自体は削除されません");
  });
});
