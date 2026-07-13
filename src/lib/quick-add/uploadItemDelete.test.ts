import { describe, it, expect } from "vitest";
import { collectUploadItemStoragePaths } from "@/lib/quick-add/uploadItemDelete";

describe("collectUploadItemStoragePaths", () => {
  it("collects all three paths when present", () => {
    expect(
      collectUploadItemStoragePaths({
        tempStoragePath: "ws1/uploads/s1/i1/original.jpg",
        tempThumbnailPath: "ws1/uploads/s1/i1/thumbnail.webp",
        tempPreviewPath: "ws1/uploads/s1/i1/preview.webp",
      }),
    ).toEqual([
      "ws1/uploads/s1/i1/original.jpg",
      "ws1/uploads/s1/i1/thumbnail.webp",
      "ws1/uploads/s1/i1/preview.webp",
    ]);
  });

  it("omits null thumbnail/preview paths", () => {
    expect(
      collectUploadItemStoragePaths({
        tempStoragePath: "ws1/uploads/s1/i1/original.jpg",
        tempThumbnailPath: null,
        tempPreviewPath: null,
      }),
    ).toEqual(["ws1/uploads/s1/i1/original.jpg"]);
  });

  it("omits an empty-string path", () => {
    expect(
      collectUploadItemStoragePaths({
        tempStoragePath: "ws1/uploads/s1/i1/original.jpg",
        tempThumbnailPath: "",
        tempPreviewPath: null,
      }),
    ).toEqual(["ws1/uploads/s1/i1/original.jpg"]);
  });

  it("returns an empty array when all paths are null", () => {
    expect(
      collectUploadItemStoragePaths({
        tempStoragePath: null,
        tempThumbnailPath: null,
        tempPreviewPath: null,
      }),
    ).toEqual([]);
  });
});
