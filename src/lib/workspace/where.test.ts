import { describe, it, expect } from "vitest";
import { withWorkspaceWhere } from "@/lib/workspace/where";

describe("withWorkspaceWhere", () => {
  it("no extra → { workspaceId }", () => {
    expect(withWorkspaceWhere("ws1")).toEqual({ workspaceId: "ws1" });
  });

  it("with extra → { ...extra, workspaceId }", () => {
    expect(withWorkspaceWhere("ws1", { status: "ACTIVE", deletedAt: null })).toEqual({
      status: "ACTIVE",
      deletedAt: null,
      workspaceId: "ws1",
    });
  });

  it("argument workspaceId wins even if extra smuggles one in (type-unsafe call)", () => {
    // Simulates a caller bypassing the type system (e.g. `as any`).
    const extra = { workspaceId: "attacker-ws", name: "x" } as unknown as Record<
      string,
      unknown
    >;
    const result = withWorkspaceWhere("real-ws", extra);
    expect(result.workspaceId).toBe("real-ws");
    expect(result.name).toBe("x");
  });

  it("preserves nested conditions untouched", () => {
    const extra = {
      OR: [{ name: { contains: "a" } }, { name: { contains: "b" } }],
      tags: { some: { tagId: "t1" } },
    };
    const result = withWorkspaceWhere("ws1", extra);
    expect(result).toEqual({ ...extra, workspaceId: "ws1" });
    // nested structures are the same reference (not deep-cloned/mutated)
    expect(result.OR).toBe(extra.OR);
    expect(result.tags).toBe(extra.tags);
  });

  it("does not mutate the extra object passed in", () => {
    const extra = { status: "ACTIVE" };
    withWorkspaceWhere("ws1", extra);
    expect(extra).toEqual({ status: "ACTIVE" });
  });
});
