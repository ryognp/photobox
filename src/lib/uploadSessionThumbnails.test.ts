import { describe, it, expect } from "vitest";
import { attachThumbnailSignedUrls } from "@/lib/uploadSessionThumbnails";
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
  it("attaches signedUrls.thumbnail when a matching result exists (matched by id)", () => {
    const items = [{ id: "item-1", originalName: "a.jpg" }];
    const results = [makeResult({ id: "item-1" })];
    const merged = attachThumbnailSignedUrls(items, results);
    expect(merged).toHaveLength(1);
    expect(merged[0].signedUrls).toEqual({
      thumbnail: { signedUrl: "https://example.test/signed/thumb.webp", fallback: false },
    });
    // other item fields preserved
    expect(merged[0].originalName).toBe("a.jpg");
  });

  it("preserves the fallback flag (preview/original used instead of missing thumbnail)", () => {
    const items = [{ id: "item-1" }];
    const results = [makeResult({ id: "item-1", fallback: true })];
    const merged = attachThumbnailSignedUrls(items, results);
    expect(merged[0].signedUrls?.thumbnail.fallback).toBe(true);
  });

  it("signedUrls is null when no result matches the item id (resolution failed/forbidden/not found)", () => {
    const items = [{ id: "item-1" }, { id: "item-2" }];
    const results = [makeResult({ id: "item-1" })]; // item-2 has no result
    const merged = attachThumbnailSignedUrls(items, results);
    expect(merged[0].signedUrls).not.toBeNull();
    expect(merged[1].signedUrls).toBeNull();
  });

  it("signedUrl null within a resolved result (no path could be signed) surfaces as null, not omitted", () => {
    const items = [{ id: "item-1" }];
    const results = [makeResult({ id: "item-1", signedUrl: null, fallback: null })];
    const merged = attachThumbnailSignedUrls(items, results);
    expect(merged[0].signedUrls).toEqual({ thumbnail: { signedUrl: null, fallback: null } });
  });

  it("matches by id, not array order/index", () => {
    const items = [{ id: "item-1" }, { id: "item-2" }];
    // results deliberately out of order relative to items
    const results = [makeResult({ id: "item-2", signedUrl: "url-2" }), makeResult({ id: "item-1", signedUrl: "url-1" })];
    const merged = attachThumbnailSignedUrls(items, results);
    expect(merged[0].signedUrls?.thumbnail.signedUrl).toBe("url-1");
    expect(merged[1].signedUrls?.thumbnail.signedUrl).toBe("url-2");
  });

  it("empty items / empty results → empty array", () => {
    expect(attachThumbnailSignedUrls([], [])).toEqual([]);
  });
});
