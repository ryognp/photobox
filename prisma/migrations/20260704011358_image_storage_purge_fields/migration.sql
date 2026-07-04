-- CreateEnum
CREATE TYPE "ImagePurgeStatus" AS ENUM ('NONE', 'PURGED', 'FAILED');

-- AlterTable
ALTER TABLE "images" ADD COLUMN     "storage_purge_error" TEXT,
ADD COLUMN     "storage_purge_status" "ImagePurgeStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "storage_purged_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "images_status_storage_purge_status_deleted_at_idx" ON "images"("status", "storage_purge_status", "deleted_at");
