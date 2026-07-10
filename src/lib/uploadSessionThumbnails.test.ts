import { describe, it, expect } from "vitest";
import { attachThumbnailSignedUrls, buildThumbnailSignedUrlRequests } from "@/lib/uploadSessionThumbnails";
import type { SignedUrlResult } from "@/lib/signedUrl";

function makeResult(over: Partial<SignedUrlResult> = {}): SignedUrlResult {
  return {
    index: 0,
    type: "uploadItem",
    id: "item-1",
    variant: "thumbnail",
    signedUrl: "https://example.test/signed/thumb.webp",
    expiresAt: "2026-07-10T01:00:00.000Z",
    fallback: false,
    ...over,
  };
}

describe("attachThumbnailSignedUrls", () => {
  it("attaches signedUrls.thumbnail when a matching result exists at the same index", () => {
    const items = [{ id: "item-1", originalName: "a.jpg" }];
    const results = [makeResult({ index: 0 })];
    const merged = attachThumbnailSignedUrls(items, results);
    expect(merged).toHaveLength(1);
    expect(merged[0].signedUrls).toEqual({
      thumbnail: { signedUrl: "https://example.test/signed/thumb.webp", fallback: false },
    });
    expect(merged[0].originalName).toBe("a.jpg");
  });

  it("matches by index even when the result's id differs from item.id (COMMITTED item → image id)", () => {
    // item-1 is COMMITTED, so its request targets the Image (committedImageId
    // "img-99"), not the uploadItem itself — result.id is "img-99", not "item-1".
    const items = [{ id: "item-1" }];
    const results = [makeResult({ index: 0, type: "image", id: "img-99", signedUrl: "url-img" })];
    const merged = attachThumbnailSignedUrls(items, results);
    expect(merged[0].signedUrls?.thumbnail.signedUrl).toBe("url-img");
  });

  it("preserves the fallback flag (preview/original used instead of missing thumbnail)", () => {
    const items = [{ id: "item-1" }];
    const results = [makeResult({ index: 0, fallback: true })];
    const merged = attachThumbnailSignedUrls(items, results);
    expect(merged[0].signedUrls?.thumbnail.fallback).toBe(true);
  });

  it("signedUrls is null when no result matches the item's index (resolution failed/forbidden/not found)", () => {
    const items = [{ id: "item-1" }, { id: "item-2" }];
    const results = [makeResult({ index: 0 })]; // index 1 (item-2) has no result
    const merged = attachThumbnailSignedUrls(items, results);
    expect(merged[0].signedUrls).not.toBeNull();
    expect(merged[1].signedUrls).toBeNull();
  });

  it("signedUrl null within a resolved result (no path could be signed) surfaces as null, not omitted", () => {
    const items = [{ id: "item-1" }];
    const results = [makeResult({ index: 0, signedUrl: null, fallback: null })];
    const merged = attachThumbnailSignedUrls(items, results);
    expect(merged[0].signedUrls).toEqual({ thumbnail: { signedUrl: null, fallback: null } });
  });

  it("results out of array order still merge correctly (matched by index field, not array position)", () => {
    const items = [{ id: "item-1" }, { id: "item-2" }];
    const results = [
      makeResult({ index: 1, id: "item-2", signedUrl: "url-2" }),
      makeResult({ index: 0, id: "item-1", signedUrl: "url-1" }),
    ];
    const merged = attachThumbnailSignedUrls(items, results);
    expect(merged[0].signedUrls?.thumbnail.signedUrl).toBe("url-1");
    expect(merged[1].signedUrls?.thumbnail.signedUrl).toBe("url-2");
  });

  it("empty items / empty results → empty array", () => {
    expect(attachThumbnailSignedUrls([], [])).toEqual([]);
  });
});

describe("buildThumbnailSignedUrlRequests", () => {
  it("not-yet-committed item → type:uploadItem, id: item.id", () => {
    const items = [{ id: "item-1", commitStatus: "PENDING", committedImageId: null }];
    expect(buildThumbnailSignedUrlRequests(items)).toEqual([
      { index: 0, type: "uploadItem", id: "item-1", variant: "thumbnail" },
    ]);
  });

  it("COMMITTED item with committedImageId → type:image, id: committedImageId (NOT item.id)", () => {
    const items = [{ id: "item-1", commitStatus: "COMMITTED", committedImageId: "img-99" }];
    expect(buildThumbnailSignedUrlRequests(items)).toEqual([
      { index: 0, type: "image", id: "img-99", variant: "thumbnail" },
    ]);
  });

  it("COMMITTED item WITHOUT committedImageId (defensive/inconsistent state) → falls back to uploadItem", () => {
    const items = [{ id: "item-1", commitStatus: "COMMITTED", committedImageId: null }];
    expect(buildThumbnailSignedUrlRequests(items)).toEqual([
      { index: 0, type: "uploadItem", id: "item-1", variant: "thumbnail" },
    ]);
  });

  it("index reflects array position across a mixed committed/not-committed batch", () => {
    const items = [
      { id: "item-a", commitStatus: "COMMITTED", committedImageId: "img-a" },
      { id: "item-b", commitStatus: "PENDING", committedImageId: null },
      { id: "item-c", commitStatus: "FAILED", committedImageId: null },
    ];
    const requests = buildThumbnailSignedUrlRequests(items);
    expect(requests).toEqual([
      { index: 0, type: "image", id: "img-a", variant: "thumbnail" },
      { index: 1, type: "uploadItem", id: "item-b", variant: "thumbnail" },
      { index: 2, type: "uploadItem", id: "item-c", variant: "thumbnail" },
    ]);
  });

  it("empty items → empty requests", () => {
    expect(buildThumbnailSignedUrlRequests([])).toEqual([]);
  });
});
