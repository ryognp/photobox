import { describe, it, expect } from "vitest";
import { normalizeBulkImageIds, BULK_IMAGE_IDS_MAX } from "@/lib/gallery/bulkImageIds";

describe("normalizeBulkImageIds", () => {
  it("rejects a non-array value", () => {
    expect(normalizeBulkImageIds("img1")).toEqual({ ok: false, error: "imageIds must be an array" });
    expect(normalizeBulkImageIds(undefined)).toEqual({ ok: false, error: "imageIds must be an array" });
    expect(normalizeBulkImageIds(null)).toEqual({ ok: false, error: "imageIds must be an array" });
    expect(normalizeBulkImageIds({ length: 1 })).toEqual({ ok: false, error: "imageIds must be an array" });
  });

  it("rejects an empty array", () => {
    expect(normalizeBulkImageIds([])).toEqual({ ok: false, error: "imageIds must not be empty" });
  });

  it("accepts exactly BULK_IMAGE_IDS_MAX (100) unique ids", () => {
    const ids = Array.from({ length: BULK_IMAGE_IDS_MAX }, (_, i) => `img-${i}`);
    const result = normalizeBulkImageIds(ids);
    expect(result).toEqual({ ok: true, imageIds: ids, requestedCount: BULK_IMAGE_IDS_MAX });
  });

  it("rejects 101 ids (exceeds max)", () => {
    const ids = Array.from({ length: BULK_IMAGE_IDS_MAX + 1 }, (_, i) => `img-${i}`);
    const result = normalizeBulkImageIds(ids);
    expect(result).toEqual({
      ok: false,
      error: `imageIds must not exceed ${BULK_IMAGE_IDS_MAX} items`,
    });
  });

  it("dedupes duplicate imageIds", () => {
    const result = normalizeBulkImageIds(["a", "b", "a", "c", "b"]);
    expect(result).toEqual({ ok: true, imageIds: ["a", "b", "c"], requestedCount: 5 });
  });

  it("rejects an empty string entry", () => {
    expect(normalizeBulkImageIds(["a", ""])).toEqual({
      ok: false,
      error: "imageIds must not contain empty strings",
    });
  });

  it("rejects a non-string entry", () => {
    expect(normalizeBulkImageIds(["a", 123])).toEqual({
      ok: false,
      error: "imageIds must contain only strings",
    });
  });

  it("requestedCount reflects the ORIGINAL array length, not the deduped count", () => {
    const result = normalizeBulkImageIds(["a", "a", "a"]);
    expect(result).toEqual({ ok: true, imageIds: ["a"], requestedCount: 3 });
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b", "a"];
    const copy = [...input];
    normalizeBulkImageIds(input);
    expect(input).toEqual(copy);
  });
});
