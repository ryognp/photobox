-- CreateEnum
CREATE TYPE "TranslationStatus" AS ENUM ('NONE', 'PENDING', 'DONE', 'FAILED', 'SKIPPED_ALREADY_JA');

-- AlterTable
ALTER TABLE "prompts" ADD COLUMN     "translated_at" TIMESTAMP(3),
ADD COLUMN     "translated_body_ja" TEXT,
ADD COLUMN     "translated_from_body_hash" TEXT,
ADD COLUMN     "translation_error" TEXT,
ADD COLUMN     "translation_model" TEXT,
ADD COLUMN     "translation_provider" TEXT,
ADD COLUMN     "translation_started_at" TIMESTAMP(3),
ADD COLUMN     "translation_status" "TranslationStatus" NOT NULL DEFAULT 'NONE';

-- CreateIndex
CREATE INDEX "prompts_workspace_id_translation_status_idx" ON "prompts"("workspace_id", "translation_status");

-- CreateIndex
CREATE INDEX "prompts_workspace_id_translation_status_translation_started_idx" ON "prompts"("workspace_id", "translation_status", "translation_started_at");
