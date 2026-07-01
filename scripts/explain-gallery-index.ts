/**
 * Dev-only diagnostic: EXPLAIN ANALYZE for the gallery list query.
 * Run with:  npm run db:migrate -- --skip  (no-op) then:
 *   dotenv -e .env.migrate -- npx tsx scripts/explain-gallery-index.ts
 */
import { loadEnv, createPrisma } from "./_lib/clients";

loadEnv();
// .env.migrate は dotenv-cli 経由で注入済みのため loadEnv() は上書きしない
// DATABASE_URL が .env.migrate の値になっていることを前提とする

const prisma = createPrisma();

async function main() {
  // 1. Image 件数
  const counts = await prisma.$queryRaw<{ total: bigint; active: bigint }[]>`
    SELECT
      COUNT(*)                                                           AS total,
      COUNT(*) FILTER (WHERE status = 'ACTIVE' AND deleted_at IS NULL)  AS active
    FROM images
  `;
  console.log("=== Image counts ===");
  console.log(`  total : ${counts[0].total}`);
  console.log(`  active: ${counts[0].active}`);

  // 2. Index 一覧
  const indexes = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'images'
    ORDER BY indexname
  `;
  console.log("\n=== Indexes on images ===");
  for (const ix of indexes) {
    console.log(`  [${ix.indexname}]`);
    console.log(`    ${ix.indexdef}`);
  }

  // 3. EXPLAIN ANALYZE — gallery list クエリ相当
  //    workspace_id は実在する値を1件取得して使用（値はログに出さない）
  const ws = await prisma.$queryRaw<{ workspace_id: string }[]>`
    SELECT workspace_id FROM images WHERE status = 'ACTIVE' AND deleted_at IS NULL LIMIT 1
  `;
  if (ws.length === 0) {
    console.log("\nNo active images found — skipping EXPLAIN.");
    return;
  }

  const explain = await prisma.$queryRaw<{ "QUERY PLAN": string }[]>`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    SELECT id, created_at
    FROM images
    WHERE workspace_id  = ${ws[0].workspace_id}
      AND status        = 'ACTIVE'
      AND deleted_at    IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 49
  `;
  console.log("\n=== EXPLAIN (ANALYZE, BUFFERS) — gallery list ===");
  for (const row of explain) {
    console.log(row["QUERY PLAN"]);
  }

  // 4. 部分インデックス（CONCURRENTLY版）の比較 SQL を表示
  console.log(`
=== Partial index option (manual SQL, not in Prisma migration) ===
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_images_gallery_list_partial"
  ON "images"("workspace_id", "created_at" DESC, "id" DESC)
  WHERE "status" = 'ACTIVE'
    AND "deleted_at" IS NULL;

-- 上記は Prisma manage 外。本番では psql / Supabase SQL Editor で実行。
-- Prisma schema の @@index は通常インデックスのまま維持し、
-- partial index は追加の最適化として並存させる形が現実的。
`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
