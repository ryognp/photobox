import { describe, it, expect } from "vitest";
import {
  parseGalleryDensity,
  getGalleryDensityGridClass,
  getGalleryDensityLabel,
  GALLERY_DENSITY_STORAGE_KEY,
} from "@/lib/gallery/galleryDensity";

describe("GALLERY_DENSITY_STORAGE_KEY", () => {
  it("is a stable, versioned key", () => {
    expect(GALLERY_DENSITY_STORAGE_KEY).toBe("photobox:gallery-density:v1");
  });
});

describe("parseGalleryDensity", () => {
  it("returns comfortable as-is", () => {
    expect(parseGalleryDensity("comfortable")).toBe("comfortable");
  });

  it("returns standard as-is", () => {
    expect(parseGalleryDensity("standard")).toBe("standard");
  });

  it("returns compact as-is", () => {
    expect(parseGalleryDensity("compact")).toBe("compact");
  });

  it("defaults to standard for null", () => {
    expect(parseGalleryDensity(null)).toBe("standard");
  });

  it("defaults to standard for undefined", () => {
    expect(parseGalleryDensity(undefined)).toBe("standard");
  });

  it("defaults to standard for an empty string", () => {
    expect(parseGalleryDensity("")).toBe("standard");
  });

  it("defaults to standard for an invalid value", () => {
    expect(parseGalleryDensity("invalid")).toBe("standard");
  });
});

describe("getGalleryDensityGridClass", () => {
  it("standard matches the pre-existing hardcoded Gallery grid classes", () => {
    expect(getGalleryDensityGridClass("standard")).toBe(
      "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5",
    );
  });

  it("comfortable uses fewer columns than standard", () => {
    expect(getGalleryDensityGridClass("comfortable")).toBe(
      "grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
    );
  });

  it("compact uses more columns than standard", () => {
    expect(getGalleryDensityGridClass("compact")).toBe(
      "grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8",
    );
  });
});

describe("getGalleryDensityLabel", () => {
  it("labels comfortable", () => {
    expect(getGalleryDensityLabel("comfortable")).toBe("大きめ");
  });

  it("labels standard", () => {
    expect(getGalleryDensityLabel("standard")).toBe("標準");
  });

  it("labels compact", () => {
    expect(getGalleryDensityLabel("compact")).toBe("コンパクト");
  });
});
