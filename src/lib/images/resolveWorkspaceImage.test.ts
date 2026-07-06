import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Prisma client before importing the helper.
const imageFindUnique = vi.fn();
const memberFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    image: { findUnique: (...a: unknown[]) => imageFindUnique(...a) },
    workspaceMember: { findUnique: (...a: unknown[]) => memberFindUnique(...a) },
  },
}));

import { resolveWorkspaceImage } from "@/lib/images/resolveWorkspaceImage";

beforeEach(() => {
  imageFindUnique.mockReset();
  memberFindUnique.mockReset();
});

const SELECT = { id: true, workspaceId: true, status: true, deletedAt: true } as const;

describe("resolveWorkspaceImage", () => {
  it("non-existent id → not_found (and does NOT look up membership)", async () => {
    imageFindUnique.mockResolvedValue(null);
    const r = await resolveWorkspaceImage({ id: "img1", userId: "u1", select: SELECT });
    expect(r.kind).toBe("not_found");
    expect(memberFindUnique).not.toHaveBeenCalled();
  });

  it("exists + non-member → forbidden (image not exposed)", async () => {
    imageFindUnique.mockResolvedValue({ id: "img1", workspaceId: "ws1", status: "ACTIVE", deletedAt: null });
    memberFindUnique.mockResolvedValue(null);
    const r = await resolveWorkspaceImage({ id: "img1", userId: "u1", select: SELECT });
    expect(r.kind).toBe("forbidden");
    expect("image" in r).toBe(false);
  });

  it("exists + member → ok + image", async () => {
    const row = { id: "img1", workspaceId: "ws1", status: "ACTIVE", deletedAt: null };
    imageFindUnique.mockResolvedValue(row);
    memberFindUnique.mockResolvedValue({ workspaceId: "ws1" });
    const r = await resolveWorkspaceImage({ id: "img1", userId: "u1", select: SELECT });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.image).toEqual(row);
  });

  it("membership lookup uses (image.workspaceId, userId)", async () => {
    imageFindUnique.mockResolvedValue({ id: "img1", workspaceId: "ws-42", status: "ACTIVE", deletedAt: null });
    memberFindUnique.mockResolvedValue({ workspaceId: "ws-42" });
    await resolveWorkspaceImage({ id: "img1", userId: "user-7", select: SELECT });
    expect(memberFindUnique).toHaveBeenCalledTimes(1);
    const arg = memberFindUnique.mock.calls[0][0];
    expect(arg.where.workspaceId_userId).toEqual({ workspaceId: "ws-42", userId: "user-7" });
  });

  it("always selects id + workspaceId regardless of caller select", async () => {
    imageFindUnique.mockResolvedValue({ id: "img1", workspaceId: "ws1" });
    memberFindUnique.mockResolvedValue({ workspaceId: "ws1" });
    await resolveWorkspaceImage({ id: "img1", userId: "u1", select: { originalName: true } });
    const arg = imageFindUnique.mock.calls[0][0];
    expect(arg.select.id).toBe(true);
    expect(arg.select.workspaceId).toBe(true);
    expect(arg.select.originalName).toBe(true);
    expect(arg.where).toEqual({ id: "img1" });
  });
});
