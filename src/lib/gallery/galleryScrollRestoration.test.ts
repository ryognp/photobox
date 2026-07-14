import { describe, it, expect } from "vitest";
import {
  buildGalleryScrollStorageKey,
  parseSavedScrollY,
  shouldRestoreScrollY,
  GALLERY_SCROLL_STORAGE_PREFIX,
  buildGalleryLastVisibleStorageKey,
  parseSavedLastVisibleImageId,
  pickMostVisibleImageId,
  GALLERY_LAST_VISIBLE_STORAGE_PREFIX,
  type VisibleImageEntry,
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

describe("buildGalleryLastVisibleStorageKey", () => {
  it("includes the prefix, pathname, and search", () => {
    expect(buildGalleryLastVisibleStorageKey("/gallery", "?tagIds=a,b")).toBe(
      `${GALLERY_LAST_VISIBLE_STORAGE_PREFIX}:/gallery:?tagIds=a,b`,
    );
  });

  it("produces a different key than the scrollY key (separate namespace)", () => {
    const scrollKey = buildGalleryScrollStorageKey("/gallery", "?q=cat");
    const lastVisibleKey = buildGalleryLastVisibleStorageKey("/gallery", "?q=cat");
    expect(lastVisibleKey).not.toBe(scrollKey);
  });

  it("produces a different key for a different search (different filter)", () => {
    const a = buildGalleryLastVisibleStorageKey("/gallery", "?q=cat");
    const b = buildGalleryLastVisibleStorageKey("/gallery", "?q=dog");
    expect(a).not.toBe(b);
  });
});

describe("parseSavedLastVisibleImageId", () => {
  it("returns null for null/undefined", () => {
    expect(parseSavedLastVisibleImageId(null)).toBeNull();
    expect(parseSavedLastVisibleImageId(undefined)).toBeNull();
  });

  it("returns null for an empty/whitespace-only string", () => {
    expect(parseSavedLastVisibleImageId("")).toBeNull();
    expect(parseSavedLastVisibleImageId("   ")).toBeNull();
  });

  it("returns the trimmed value for a valid imageId", () => {
    expect(parseSavedLastVisibleImageId("img_123")).toBe("img_123");
    expect(parseSavedLastVisibleImageId("  img_123  ")).toBe("img_123");
  });
});

describe("pickMostVisibleImageId", () => {
  it("picks the entry with the highest intersectionRatio", () => {
    const entries: VisibleImageEntry[] = [
      { id: "a", intersectionRatio: 0.3, top: 10 },
      { id: "b", intersectionRatio: 0.9, top: 200 },
      { id: "c", intersectionRatio: 0.5, top: 50 },
    ];
    expect(pickMostVisibleImageId(entries)).toBe("b");
  });

  it("breaks ties by picking the smallest top (closest to container top edge)", () => {
    const entries: VisibleImageEntry[] = [
      { id: "a", intersectionRatio: 0.5, top: 100 },
      { id: "b", intersectionRatio: 0.5, top: 20 },
      { id: "c", intersectionRatio: 0.5, top: 60 },
    ];
    expect(pickMostVisibleImageId(entries)).toBe("b");
  });

  it("ignores entries with an empty id", () => {
    const entries: VisibleImageEntry[] = [
      { id: "", intersectionRatio: 1, top: 0 },
      { id: "b", intersectionRatio: 0.4, top: 30 },
    ];
    expect(pickMostVisibleImageId(entries)).toBe("b");
  });

  it("returns null when there are no candidates", () => {
    expect(pickMostVisibleImageId([])).toBeNull();
    expect(pickMostVisibleImageId([{ id: "", intersectionRatio: 1, top: 0 }])).toBeNull();
  });

  it("does not mutate the input array", () => {
    const entries: VisibleImageEntry[] = [
      { id: "a", intersectionRatio: 0.3, top: 10 },
      { id: "b", intersectionRatio: 0.9, top: 200 },
    ];
    const copy = [...entries];
    pickMostVisibleImageId(entries);
    expect(entries).toEqual(copy);
  });
});
