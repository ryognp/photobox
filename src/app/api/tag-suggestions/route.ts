import "server-only";

import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, Errors } from "@/lib/apiResponse";
import { isExcludedGenericLabel } from "@/lib/analysis/tagTaxonomy";

/**
 * GET /api/tag-suggestions  (Phase 10-9B)
 *
 * Lists distinct PENDING AI tag-candidate labels in the caller's default
 * workspace, for the FilterSidebar / MobileFilterDrawer "AI候補タグ" section.
 * Read-only; mirrors /api/tags (auth + default workspace, no rate limit).
 *
 * - PENDING only (APPROVED are already real Tags in /api/tags; REJECTED excluded).
 * - Only ACTIVE, non-deleted images count.
 * - `imageCount` = number of DISTINCT images that have the label PENDING, NOT
 *   the TagSuggestion row count. Achieved via `distinct: ["label","imageId"]`
 *   (one row per (label,imageId) pair) then counting rows per label.
 * - Phase 10-10A: labels in EXCLUDED_GENERIC_LABELS (人物/ポートレート) are
 *   hidden here even if older PENDING rows still exist. Read-only display
 *   filter only — the TagSuggestion rows themselves are left untouched (no
 *   UPDATE/DELETE), and approve/reject remain available via the per-image API.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  // distinct on (label, imageId) → each pair once, so per-label row count is
  // exactly the distinct-image count for that label.
  const rows = await prisma.tagSuggestion.findMany({
    where: {
      workspaceId: workspace.id,
      status: "PENDING",
      image: { workspaceId: workspace.id, deletedAt: null, status: "ACTIVE" },
    },
    distinct: ["label", "imageId"],
    select: { label: true, imageId: true },
  });

  const counts = new Map<string, number>();
  for (const r of rows) {
    if (isExcludedGenericLabel(r.label)) continue;
    counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  }

  const data = Array.from(counts.entries())
    .map(([label, imageCount]) => ({ label, imageCount }))
    .sort((a, b) => a.label.localeCompare(b.label, "ja"));

  return ok(data);
}
