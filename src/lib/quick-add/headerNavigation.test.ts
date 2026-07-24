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

  it("defaultPrevented済み → bypass(二重処理しない)", () => {
    expect(classifyNavigationActivation(info({ defaultPrevented: true }), false)).toBe("bypass");
    // 保存中でも defaultPrevented が優先される
    expect(classifyNavigationActivation(info({ defaultPrevented: true }), true)).toBe("bypass");
  });
});

describe("classifyNavigationActivation (saving)", () => {
  it("保存中 + primary click → block", () => {
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

  it("保存中 + 中クリック → block", () => {
    expect(classifyNavigationActivation(info({ button: 1 }), true)).toBe("block");
  });
});
