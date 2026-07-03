import { describe, it, expect, vi } from "vitest";
import { cleanupUploadsCore, type CleanupSession } from "@/lib/cleanup/cleanupUploadsCore";

describe("cleanupUploadsCore", () => {
  it("deletes DB record after successful storage removal", async () => {
    const sessions: CleanupSession[] = [
      { id: "s1", status: "ABANDONED", tempPaths: ["a", "b"] },
    ];
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const res = await cleanupUploadsCore(sessions, {
      removeStorage: vi.fn().mockResolvedValue({ error: null }),
      deleteSession,
    });
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(res.deletedSessions).toBe(1);
    expect(res.deletedStoragePaths).toBe(2);
    expect(res.retainedSessions).toBe(0);
  });

  it("does NOT delete DB record when storage removal fails", async () => {
    const sessions: CleanupSession[] = [
      { id: "s1", status: "ACTIVE", tempPaths: ["a"] },
    ];
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const res = await cleanupUploadsCore(sessions, {
      removeStorage: vi.fn().mockResolvedValue({ error: "network error" }),
      deleteSession,
    });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(res.deletedSessions).toBe(0);
    expect(res.retainedSessions).toBe(1);
    expect(res.deletedStoragePaths).toBe(0);
    expect(res.warnings[0]).toContain("storage remove failed");
  });

  it("deletes sessions with no temp paths without touching storage", async () => {
    const sessions: CleanupSession[] = [
      { id: "s1", status: "ABANDONED", tempPaths: [] },
    ];
    const removeStorage = vi.fn();
    const res = await cleanupUploadsCore(sessions, {
      removeStorage,
      deleteSession: vi.fn().mockResolvedValue(undefined),
    });
    expect(removeStorage).not.toHaveBeenCalled();
    expect(res.deletedSessions).toBe(1);
  });

  it("retains a session and warns when DB delete throws", async () => {
    const sessions: CleanupSession[] = [
      { id: "s1", status: "ACTIVE", tempPaths: ["a"] },
    ];
    const res = await cleanupUploadsCore(sessions, {
      removeStorage: vi.fn().mockResolvedValue({ error: null }),
      deleteSession: vi.fn().mockRejectedValue(new Error("status changed to COMMITTED")),
    });
    expect(res.deletedSessions).toBe(0);
    expect(res.retainedSessions).toBe(1);
    // storage was still removed for this session
    expect(res.deletedStoragePaths).toBe(1);
    expect(res.warnings[0]).toContain("DB delete failed");
  });

  it("processes a mixed batch independently per session", async () => {
    const sessions: CleanupSession[] = [
      { id: "ok1", status: "ABANDONED", tempPaths: ["a"] },
      { id: "fail", status: "ACTIVE", tempPaths: ["b"] },
      { id: "ok2", status: "PREVIEWING", tempPaths: [] },
    ];
    const res = await cleanupUploadsCore(sessions, {
      removeStorage: vi.fn(async (paths: string[]) =>
        paths.includes("b") ? { error: "boom" } : { error: null },
      ),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    });
    expect(res.scannedSessions).toBe(3);
    expect(res.deletedSessions).toBe(2);
    expect(res.retainedSessions).toBe(1);
    expect(res.deletedStoragePaths).toBe(1);
  });
});
