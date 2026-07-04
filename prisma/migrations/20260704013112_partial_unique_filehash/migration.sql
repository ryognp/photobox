-- Replace the plain unique constraint on (workspace_id, file_hash) with a
-- PARTIAL unique index scoped to live images only. Soft-deleted rows
-- (deleted_at IS NOT NULL or status = 'DELETED') no longer occupy the unique
-- space, so the same file can be re-uploaded after it was deleted, while
-- duplicate uploads among live images are still rejected.
--
-- Partial indexes cannot be expressed in the Prisma schema, so the matching
-- @@unique was removed from schema.prisma and this index is managed here.

DROP INDEX IF EXISTS "images_workspace_id_file_hash_key";

CREATE UNIQUE INDEX "idx_images_workspace_file_hash_not_deleted_unique"
ON "images" ("workspace_id", "file_hash")
WHERE "deleted_at" IS NULL AND "status" <> 'DELETED';
