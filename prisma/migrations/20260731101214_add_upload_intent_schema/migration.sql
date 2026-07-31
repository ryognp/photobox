-- CreateEnum
CREATE TYPE "UploadIntentStatus" AS ENUM ('PREPARED', 'FINALIZING', 'FINALIZED', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IntentStorageCleanupStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "upload_sessions" ADD COLUMN     "cleanup_attempt_token" VARCHAR(36),
ADD COLUMN     "cleanup_lease_until" TIMESTAMP(3),
ADD COLUMN     "next_upload_sort_order" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "upload_intents" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reserved_upload_item_id" TEXT NOT NULL,
    "client_upload_id" TEXT NOT NULL,
    "request_fingerprint" VARCHAR(64) NOT NULL,
    "status" "UploadIntentStatus" NOT NULL DEFAULT 'PREPARED',
    "declared_original_name" VARCHAR(255) NOT NULL,
    "declared_mime_type" VARCHAR(32) NOT NULL,
    "declared_size_bytes" INTEGER NOT NULL,
    "client_file_hash" VARCHAR(64) NOT NULL,
    "staging_original_path" TEXT NOT NULL,
    "canonical_original_path" TEXT,
    "reserved_sort_order" INTEGER NOT NULL,
    "variant_profile_version" VARCHAR(16) NOT NULL,
    "token_issue_deadline_at" TIMESTAMP(3) NOT NULL,
    "intent_finalize_deadline_at" TIMESTAMP(3) NOT NULL,
    "storage_cleanup_not_before" TIMESTAMP(3) NOT NULL,
    "signed_upload_issued_at" TIMESTAMP(3),
    "signed_upload_expires_at" TIMESTAMP(3),
    "finalize_started_at" TIMESTAMP(3),
    "finalize_lease_until" TIMESTAMP(3),
    "finalize_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "finalize_attempt_token" VARCHAR(36),
    "cleanup_lease_until" TIMESTAMP(3),
    "cleanup_attempt_token" VARCHAR(36),
    "storage_cleanup_status" "IntentStorageCleanupStatus" NOT NULL DEFAULT 'PENDING',
    "storage_cleanup_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "storage_cleaned_at" TIMESTAMP(3),
    "storage_cleanup_last_error_code" VARCHAR(64),
    "finalized_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "last_error_code" VARCHAR(64),
    "last_error_detail" VARCHAR(256),
    "upload_item_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "upload_intents_reserved_upload_item_id_key" ON "upload_intents"("reserved_upload_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "upload_intents_upload_item_id_key" ON "upload_intents"("upload_item_id");

-- CreateIndex
CREATE INDEX "upload_intents_session_id_status_idx" ON "upload_intents"("session_id", "status");

-- CreateIndex
CREATE INDEX "upload_intents_status_intent_finalize_deadline_at_idx" ON "upload_intents"("status", "intent_finalize_deadline_at");

-- CreateIndex
CREATE INDEX "upload_intents_status_finalize_lease_until_idx" ON "upload_intents"("status", "finalize_lease_until");

-- CreateIndex
CREATE INDEX "upload_intents_storage_cleanup_status_storage_cleanup_not_b_idx" ON "upload_intents"("storage_cleanup_status", "storage_cleanup_not_before");

-- CreateIndex
CREATE INDEX "upload_intents_workspace_id_user_id_idx" ON "upload_intents"("workspace_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "upload_intents_session_id_client_upload_id_key" ON "upload_intents"("session_id", "client_upload_id");

-- AddForeignKey
ALTER TABLE "upload_intents" ADD CONSTRAINT "upload_intents_session_id_workspace_id_fkey" FOREIGN KEY ("session_id", "workspace_id") REFERENCES "upload_sessions"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Phase 10-43-B1: sort_order 予約カウンタの移行期間サポート（手書きSQL）
--
-- 目的:
--   direct upload の prepare は upload_sessions.next_upload_sort_order の atomic
--   increment で sortOrder を発番する。しかし移行期間中は旧 multipart route
--   (POST /api/uploads/items) が従来どおり MAX(sort_order)+1 で upload_items を
--   直接 INSERT し続けるため、counter が実データから遅れる可能性がある。
--   この trigger は旧経路の INSERT に counter を追従させ、両経路が同じ発番元を
--   共有できる状態を保つ。
--
-- 不変条件:
--   - counter は決して後退しない（GREATEST を使う）
--   - upload_items.sort_order は書き換えない（counter だけを更新する）
--   - 旧経路・新経路のどちらの INSERT でも同じ規則が適用される
--
-- trigger は Prisma schema で表現できないため、この migration で管理する
-- （既存の partial unique index と同じ運用方針）。
-- 旧 route が共通 helper へ移行し終えたあと、別 migration で削除する。
-- ============================================================================

CREATE OR REPLACE FUNCTION photobox_sync_session_next_upload_sort_order()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "upload_sessions"
     SET "next_upload_sort_order" = GREATEST("next_upload_sort_order", NEW."sort_order" + 1)
   WHERE "id" = NEW."session_id"
     AND "next_upload_sort_order" < NEW."sort_order" + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER photobox_upload_items_sync_sort_order_counter
AFTER INSERT ON "upload_items"
FOR EACH ROW
EXECUTE FUNCTION photobox_sync_session_next_upload_sort_order();

-- Backfill: 既存 session の counter を MAX(sort_order)+1 へ進める。
-- trigger 作成後に実行するため、backfill と並行 INSERT が交差しても GREATEST に
-- より counter は後退しない（trigger 側も同じ規則を使う）。
-- item を持たない session は 0 のまま（COALESCE の既定値）。
UPDATE "upload_sessions" s
   SET "next_upload_sort_order" = GREATEST(
         s."next_upload_sort_order",
         COALESCE((SELECT MAX(i."sort_order") + 1 FROM "upload_items" i WHERE i."session_id" = s."id"), 0)
       );
