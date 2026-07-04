import { describe, it, expect, vi } from "vitest";
import { purgeDeletedImagesCore, type PurgeImage } from "@/lib/purge/purgeDeletedImagesCore";

describe("purgeDeletedImagesCore", () => {
  it("marks PURGED after successful storage removal", async () => {
    const images: PurgeImage[] = [{ id: "i1", paths: ["a", "b"] }];
    const markPurged = vi.fn().mockResolvedValue(undefined);
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const res = await purgeDeletedImagesCore(images, {
      removeStorage: vi.fn().mockResolvedValue({ error: null }),
      markPurged,
      markFailed,
    });
    expect(markPurged).toHaveBeenCalledWith("i1");
    expect(markFailed).not.toHaveBeenCalled();
    expect(res.purged).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.purgedStoragePaths).toBe(2);
  });

  it("marks FAILED (not PURGED) when storage removal fails", async () => {
    const images: PurgeImage[] = [{ id: "i1", paths: ["a"] }];
    const markPurged = vi.fn().mockResolvedValue(undefined);
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const res = await purgeDeletedImagesCore(images, {
      removeStorage: vi.fn().mockResolvedValue({ error: "network error" }),
      markPurged,
      markFailed,
    });
    expect(markPurged).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith("i1", "network error");
    expect(res.purged).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.purgedStoragePaths).toBe(0);
    expect(res.warnings[0]).toContain("storage remove failed");
  });

  it("truncates long storage error before markFailed", async () => {
    const longErr = "x".repeat(1000);
    const markFailed = vi.fn().mockResolvedValue(undefined);
    await purgeDeletedImagesCore([{ id: "i1", paths: ["a"] }], {
      removeStorage: vi.fn().mockResolvedValue({ error: longErr }),
      markPurged: vi.fn(),
      markFailed,
    });
    expect(markFailed.mock.calls[0][1].length).toBe(500);
  });

  it("warns and counts failed when markPurged throws (reconcile next run)", async () => {
    const images: PurgeImage[] = [{ id: "i1", paths: ["a"] }];
    const res = await purgeDeletedImagesCore(images, {
      removeStorage: vi.fn().mockResolvedValue({ error: null }),
      markPurged: vi.fn().mockRejectedValue(new Error("db down")),
      markFailed: vi.fn(),
    });
    expect(res.purged).toBe(0);
    expect(res.failed).toBe(1);
    // storage was still removed
    expect(res.purgedStoragePaths).toBe(1);
    expect(res.warnings[0]).toContain("markPurged threw");
    expect(res.warnings[0]).toContain("reconcile next run");
  });

  it("continues the batch when markFailed throws", async () => {
    const images: PurgeImage[] = [{ id: "i1", paths: ["a"] }];
    const res = await purgeDeletedImagesCore(images, {
      removeStorage: vi.fn().mockResolvedValue({ error: "boom" }),
      markPurged: vi.fn(),
      markFailed: vi.fn().mockRejectedValue(new Error("db down")),
    });
    expect(res.failed).toBe(1);
    expect(res.warnings.some((w) => w.includes("markFailed threw"))).toBe(true);
  });

  it("empty paths → FAILED (NO_STORAGE_PATHS), not PURGED", async () => {
    const markPurged = vi.fn();
    const markFailed = vi.fn().mockResolvedValue(undefined);
    const removeStorage = vi.fn();
    const res = await purgeDeletedImagesCore([{ id: "i1", paths: [null, undefined] }], {
      removeStorage,
      markPurged,
      markFailed,
    });
    expect(removeStorage).not.toHaveBeenCalled();
    expect(markPurged).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith("i1", "NO_STORAGE_PATHS");
    expect(res.failed).toBe(1);
    expect(res.purged).toBe(0);
  });

  it("dedupes paths before removeStorage", async () => {
    const removeStorage = vi.fn().mockResolvedValue({ error: null });
    await purgeDeletedImagesCore([{ id: "i1", paths: ["a", "a", "b", null] }], {
      removeStorage,
      markPurged: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn(),
    });
    expect(removeStorage).toHaveBeenCalledWith(["a", "b"]);
  });

  it("removes only the present path when thumbnail/preview are null", async () => {
    const removeStorage = vi.fn().mockResolvedValue({ error: null });
    await purgeDeletedImagesCore([{ id: "i1", paths: ["orig.jpg", null, null] }], {
      removeStorage,
      markPurged: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn(),
    });
    expect(removeStorage).toHaveBeenCalledWith(["orig.jpg"]);
  });

  it("processes a mixed batch independently", async () => {
    const images: PurgeImage[] = [
      { id: "ok", paths: ["a"] },
      { id: "fail", paths: ["b"] },
      { id: "empty", paths: [] },
    ];
    const res = await purgeDeletedImagesCore(images, {
      removeStorage: vi.fn(async (paths: string[]) =>
        paths.includes("b") ? { error: "boom" } : { error: null },
      ),
      markPurged: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    });
    expect(res.scanned).toBe(3);
    expect(res.purged).toBe(1);
    expect(res.failed).toBe(2);
    expect(res.purgedStoragePaths).toBe(1);
  });
});
