-- CreateEnum
CREATE TYPE "AnalysisSource" AS ENUM ('PROMPT', 'VISION', 'HYBRID');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'SKIPPED_NO_PROMPT');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "image_analyses" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "image_id" TEXT NOT NULL,
    "source" "AnalysisSource" NOT NULL DEFAULT 'PROMPT',
    "schema_version" TEXT NOT NULL DEFAULT 'prompt-v1',
    "model_id" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "raw_json" JSONB,
    "usage_category" TEXT,
    "keywords_ja" JSONB,
    "keywords_en" JSONB,
    "language_detected" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "image_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tag_suggestions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "image_id" TEXT NOT NULL,
    "analysis_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "approved_tag_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "image_analyses_workspace_id_status_idx" ON "image_analyses"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "image_analyses_image_id_idx" ON "image_analyses"("image_id");

-- CreateIndex
CREATE UNIQUE INDEX "image_analyses_image_id_source_model_id_schema_version_key" ON "image_analyses"("image_id", "source", "model_id", "schema_version");

-- CreateIndex
CREATE INDEX "tag_suggestions_workspace_id_image_id_status_idx" ON "tag_suggestions"("workspace_id", "image_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tag_suggestions_analysis_id_label_key" ON "tag_suggestions"("analysis_id", "label");

-- AddForeignKey
ALTER TABLE "image_analyses" ADD CONSTRAINT "image_analyses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_analyses" ADD CONSTRAINT "image_analyses_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_suggestions" ADD CONSTRAINT "tag_suggestions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_suggestions" ADD CONSTRAINT "tag_suggestions_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tag_suggestions" ADD CONSTRAINT "tag_suggestions_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "image_analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
