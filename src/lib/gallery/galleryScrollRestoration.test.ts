import { describe, it, expect } from "vitest";
import {
  buildGalleryScrollStorageKey,
  parseSavedScrollY,
  shouldRestoreScrollY,
  GALLERY_SCROLL_STORAGE_PREFIX,
} from "@/lib/gallery/galleryScrollRestoration";

describe("buildGalleryScrollStorageKey", () => {
  it("includes the prefix, pathname, and search", () => {
    expect(buildGalleryScrollStorageKey("/gallery", "?tagIds=a,b")).toBe(
      `${GALLERY_SCROLL_STORAGE_PREFIX}:/gallery:?tagIds=a,b`,
    );
  });

  it("produces the same key for the same pathname+search", () => {
    const a = buildGalleryScrollStorageKey("/gallery", "?q=cat");
    const b = buildGalleryScrollStorageKey("/gallery", "?q=cat");
    expect(a).toBe(b);
  });

  it("produces a different key for a different search (different filter)", () => {
    const a = buildGalleryScrollStorageKey("/gallery", "?q=cat");
    const b = buildGalleryScrollStorageKey("/gallery", "?q=dog");
    expect(a).not.toBe(b);
  });

  it("handles an empty search string", () => {
    expect(buildGalleryScrollStorageKey("/gallery", "")).toBe(
      `${GALLERY_SCROLL_STORAGE_PREFIX}:/gallery:`,
    );
  });
});

describe("parseSavedScrollY", () => {
  it("parses a valid positive number string", () => {
    expect(parseSavedScrollY("1234")).toBe(1234);
  });

  it("parses zero", () => {
    expect(parseSavedScrollY("0")).toBe(0);
  });

  it("returns null for null/undefined", () => {
    expect(parseSavedScrollY(null)).toBeNull();
    expect(parseSavedScrollY(undefined)).toBeNull();
  });

  it("returns null for an empty/whitespace-only string", () => {
    expect(parseSavedScrollY("")).toBeNull();
    expect(parseSavedScrollY("   ")).toBeNull();
  });

  it("returns null for a non-numeric string", () => {
    expect(parseSavedScrollY("abc")).toBeNull();
  });

  it("returns null for a negative value", () => {
    expect(parseSavedScrollY("-5")).toBeNull();
  });

  it("returns null for a non-finite value", () => {
    expect(parseSavedScrollY("Infinity")).toBeNull();
  });
});

describe("shouldRestoreScrollY", () => {
  it("is false for null", () => {
    expect(shouldRestoreScrollY(null)).toBe(false);
  });

  it("is false for zero (no-op restore)", () => {
    expect(shouldRestoreScrollY(0)).toBe(false);
  });

  it("is true for a positive value", () => {
    expect(shouldRestoreScrollY(150)).toBe(true);
  });
});
