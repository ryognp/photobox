import { describe, it, expect } from "vitest";
import { classifyNavigationActivation, type NavigationEventInfo } from "@/lib/quick-add/headerNavigation";

function info(overrides: Partial<NavigationEventInfo> = {}): NavigationEventInfo {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("classifyNavigationActivation (not saving)", () => {
  it("通常のprimary click(button=0, 修飾キーなし) → guard", () => {
    expect(classifyNavigationActivation(info(), false)).toBe("guard");
  });

  it("metaKey → bypass", () => {
    expect(classifyNavigationActivation(info({ metaKey: true }), false)).toBe("bypass");
  });

  it("ctrlKey → bypass", () => {
    expect(classifyNavigationActivation(info({ ctrlKey: true }), false)).toBe("bypass");
  });

  it("shiftKey → bypass", () => {
    expect(classifyNavigationActivation(info({ shiftKey: true }), false)).toBe("bypass");
  });

  it("altKey → bypass", () => {
    expect(classifyNavigationActivation(info({ altKey: true }), false)).toBe("bypass");
  });

  it("middle click(button=1) → bypass", () => {
    expect(classifyNavigationActivation(info({ button: 1 }), false)).toBe("bypass");
  });

  it("defaultPrevented済み → ignore(二重処理しない)", () => {
    expect(classifyNavigationActivation(info({ defaultPrevented: true }), false)).toBe("ignore");
    // 保存中でも defaultPrevented が優先される
    expect(classifyNavigationActivation(info({ defaultPrevented: true }), true)).toBe("ignore");
  });
});

describe("classifyNavigationActivation (saving)", () => {
  it("保存中 + primary click(button=0) → block", () => {
    expect(classifyNavigationActivation(info(), true)).toBe("block");
  });

  it("保存中 + 修飾キークリック(metaKey) → block", () => {
    expect(classifyNavigationActivation(info({ metaKey: true }), true)).toBe("block");
  });

  it("保存中 + 修飾キークリック(ctrlKey) → block", () => {
    expect(classifyNavigationActivation(info({ ctrlKey: true }), true)).toBe("block");
  });

  it("保存中 + 修飾キークリック(shiftKey) → block", () => {
    expect(classifyNavigationActivation(info({ shiftKey: true }), true)).toBe("block");
  });

  it("保存中 + 修飾キークリック(altKey) → block", () => {
    expect(classifyNavigationActivation(info({ altKey: true }), true)).toBe("block");
  });

  it("保存中 + 中クリック(button=1) → block", () => {
    expect(classifyNavigationActivation(info({ button: 1 }), true)).toBe("block");
  });
});

describe("classifyNavigationActivation (対象外button → ignore、Quick Add側では一切処理しない)", () => {
  it("保存中でない右クリック(button=2) → ignore", () => {
    expect(classifyNavigationActivation(info({ button: 2 }), false)).toBe("ignore");
  });

  it("保存中の右クリック(button=2) → ignore(blockにしない — コンテキストメニューを維持)", () => {
    expect(classifyNavigationActivation(info({ button: 2 }), true)).toBe("ignore");
  });

  it("戻るボタン(button=3) → ignore", () => {
    expect(classifyNavigationActivation(info({ button: 3 }), false)).toBe("ignore");
    expect(classifyNavigationActivation(info({ button: 3 }), true)).toBe("ignore");
  });

  it("進むボタン(button=4) → ignore", () => {
    expect(classifyNavigationActivation(info({ button: 4 }), false)).toBe("ignore");
    expect(classifyNavigationActivation(info({ button: 4 }), true)).toBe("ignore");
  });

  it("button=-1など対象外の負値 → ignore", () => {
    expect(classifyNavigationActivation(info({ button: -1 }), false)).toBe("ignore");
  });

  it("button=2 に修飾キーが付いていてもignore(修飾キーより先にbutton判定が優先される)", () => {
    expect(classifyNavigationActivation(info({ button: 2, metaKey: true }), false)).toBe("ignore");
    expect(classifyNavigationActivation(info({ button: 2, ctrlKey: true }), true)).toBe("ignore");
  });

  it("button=2はonNavigateが呼ばれる分類(guard/bypass/block)のいずれにもならない", () => {
    const results = [
      classifyNavigationActivation(info({ button: 2 }), false),
      classifyNavigationActivation(info({ button: 2 }), true),
      classifyNavigationActivation(info({ button: 2, metaKey: true }), false),
      classifyNavigationActivation(info({ button: 2, shiftKey: true }), true),
    ];
    for (const r of results) {
      expect(r).toBe("ignore");
      expect(r).not.toBe("guard");
      expect(r).not.toBe("bypass");
      expect(r).not.toBe("block");
    }
  });
});

describe("回帰確認: button=0/1 の既存分類は維持されている", () => {
  it("button=1(中クリック)は保存中でなければbypassのまま", () => {
    expect(classifyNavigationActivation(info({ button: 1 }), false)).toBe("bypass");
  });

  it("button=1(中クリック)は保存中ならblockのまま", () => {
    expect(classifyNavigationActivation(info({ button: 1 }), true)).toBe("block");
  });

  it("button=0の通常クリックはguardのまま", () => {
    expect(classifyNavigationActivation(info({ button: 0 }), false)).toBe("guard");
  });

  it("button=0の修飾キー付きクリックは、保存中でなければbypassのまま", () => {
    expect(classifyNavigationActivation(info({ button: 0, metaKey: true }), false)).toBe("bypass");
  });

  it("button=0の修飾キー付きクリックは、保存中ならblockのまま", () => {
    expect(classifyNavigationActivation(info({ button: 0, ctrlKey: true }), true)).toBe("block");
  });

  it("defaultPrevented済みは保存状態に関係なくignore", () => {
    expect(classifyNavigationActivation(info({ defaultPrevented: true }), false)).toBe("ignore");
    expect(classifyNavigationActivation(info({ defaultPrevented: true }), true)).toBe("ignore");
    expect(classifyNavigationActivation(info({ defaultPrevented: true, button: 1 }), false)).toBe("ignore");
  });
});
