import { describe, it, expect } from "vitest";
import { isDirectUploadEnabled } from "./directUploadFeature";

describe("isDirectUploadEnabled", () => {
  it('厳密に "true" のときだけ true', () => {
    expect(isDirectUploadEnabled("true")).toBe(true);
  });

  it("それ以外（未設定・空・大小文字違い・前後空白・truthy風文字列）は false", () => {
    for (const v of [undefined, "", "false", "1", "TRUE", "True", " true", "true ", "yes"]) {
      expect(isDirectUploadEnabled(v)).toBe(false);
    }
  });
});
