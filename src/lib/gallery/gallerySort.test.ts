import { describe, it, expect } from "vitest";
import { parseGallerySort, getGallerySortLabel, GALLERY_SORT_STORAGE_KEY } from "@/lib/gallery/gallerySort";

describe("GALLERY_SORT_STORAGE_KEY", () => {
  it("is a stable, versioned key", () => {
    expect(GALLERY_SORT_STORAGE_KEY).toBe("photobox:gallery-sort:v1");
  });
});

describe("parseGallerySort", () => {
  it("returns newest as-is", () => {
    expect(parseGallerySort("newest")).toBe("newest");
  });

  it("returns oldest as-is", () => {
    expect(parseGallerySort("oldest")).toBe("oldest");
  });

  it("returns needs_review as-is", () => {
    expect(parseGallerySort("needs_review")).toBe("needs_review");
  });

  it("defaults to newest for null", () => {
    expect(parseGallerySort(null)).toBe("newest");
  });

  it("defaults to newest for undefined", () => {
    expect(parseGallerySort(undefined)).toBe("newest");
  });

  it("defaults to newest for an empty string", () => {
    expect(parseGallerySort("")).toBe("newest");
  });

  it("defaults to newest for an invalid value", () => {
    expect(parseGallerySort("invalid")).toBe("newest");
  });
});

describe("getGallerySortLabel", () => {
  it("labels newest", () => {
    expect(getGallerySortLabel("newest")).toBe("新しい順");
  });

  it("labels oldest", () => {
    expect(getGallerySortLabel("oldest")).toBe("古い順");
  });

  it("labels needs_review", () => {
    expect(getGallerySortLabel("needs_review")).toBe("整理が必要な順");
  });
});
