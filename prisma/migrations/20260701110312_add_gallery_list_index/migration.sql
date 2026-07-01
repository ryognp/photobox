-- CreateIndex
CREATE INDEX "idx_images_gallery_list" ON "images"("workspace_id", "status", "created_at" DESC, "id" DESC);
