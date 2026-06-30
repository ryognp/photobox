-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'READY', 'ERROR');

-- CreateEnum
CREATE TYPE "PromptStatus" AS ENUM ('EMPTY', 'DRAFT', 'FILLED');

-- CreateEnum
CREATE TYPE "DuplicateStatus" AS ENUM ('UNCHECKED', 'CLEAN', 'DUPLICATE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CommitStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMMITTED', 'FAILED');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'PREVIEWING', 'COMMITTED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ImageStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "PromptVersionType" AS ENUM ('EDIT', 'SCENE_TRANSFORM');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- CreateTable
CREATE TABLE "scenes" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "persons" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "default_prompt_hint" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_groups" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "person_id" TEXT,
    "scene_id" TEXT,
    "is_favorite" BOOLEAN NOT NULL DEFAULT false,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "images" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "scene_id" TEXT,
    "status" "ImageStatus" NOT NULL DEFAULT 'ACTIVE',
    "storage_bucket" TEXT NOT NULL DEFAULT 'photobox-private',
    "storage_path" TEXT NOT NULL,
    "thumbnail_path" TEXT,
    "preview_path" TEXT,
    "original_name" TEXT NOT NULL,
    "original_ext" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "width_px" INTEGER,
    "height_px" INTEGER,
    "file_hash" TEXT NOT NULL,
    "rating" INTEGER,
    "is_favorite" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "search_text" TEXT,
    "import_batch_id" TEXT,
    "source_sheet_name" TEXT,
    "source_row" INTEGER,
    "source_column" INTEGER,
    "upload_item_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "image_tags" (
    "image_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "image_tags_pkey" PRIMARY KEY ("image_id","tag_id")
);

-- CreateTable
CREATE TABLE "image_persons" (
    "image_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "image_persons_pkey" PRIMARY KEY ("image_id","person_id")
);

-- CreateTable
CREATE TABLE "prompts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "image_id" TEXT NOT NULL,
    "original_body" TEXT NOT NULL,
    "current_body" TEXT NOT NULL,
    "prompt_group_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_versions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "prompt_id" TEXT NOT NULL,
    "version_type" "PromptVersionType" NOT NULL,
    "body" TEXT NOT NULL,
    "scene_id" TEXT,
    "change_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "committed_at" TIMESTAMP(3),

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_items" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "original_name" TEXT NOT NULL,
    "original_ext" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "width_px" INTEGER,
    "height_px" INTEGER,
    "file_hash" TEXT NOT NULL,
    "temp_storage_path" TEXT NOT NULL,
    "temp_thumbnail_path" TEXT,
    "temp_preview_path" TEXT,
    "upload_status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "prompt_status" "PromptStatus" NOT NULL DEFAULT 'EMPTY',
    "duplicate_status" "DuplicateStatus" NOT NULL DEFAULT 'UNCHECKED',
    "commit_status" "CommitStatus" NOT NULL DEFAULT 'PENDING',
    "duplicate_image_id" TEXT,
    "prompt_draft" TEXT,
    "scene_id" TEXT,
    "rating" INTEGER,
    "is_favorite" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "reserved_image_id" TEXT,
    "asset_storage_path" TEXT,
    "asset_thumbnail_path" TEXT,
    "asset_preview_path" TEXT,
    "commit_started_at" TIMESTAMP(3),
    "committed_at" TIMESTAMP(3),
    "committed_image_id" TEXT,
    "commit_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_item_tags" (
    "upload_item_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_item_tags_pkey" PRIMARY KEY ("upload_item_id","tag_id")
);

-- CreateTable
CREATE TABLE "upload_item_persons" (
    "upload_item_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_item_persons_pkey" PRIMARY KEY ("upload_item_id","person_id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "imported_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "error_log" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE INDEX "scenes_workspace_id_idx" ON "scenes"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "scenes_workspace_id_name_key" ON "scenes"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "tags_workspace_id_idx" ON "tags"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_workspace_id_name_key" ON "tags"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "persons_workspace_id_idx" ON "persons"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "persons_workspace_id_name_key" ON "persons"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "prompt_groups_workspace_id_idx" ON "prompt_groups"("workspace_id");

-- CreateIndex
CREATE INDEX "prompt_groups_workspace_id_is_favorite_idx" ON "prompt_groups"("workspace_id", "is_favorite");

-- CreateIndex
CREATE INDEX "prompt_groups_workspace_id_person_id_idx" ON "prompt_groups"("workspace_id", "person_id");

-- CreateIndex
CREATE INDEX "images_workspace_id_status_idx" ON "images"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "images_workspace_id_scene_id_idx" ON "images"("workspace_id", "scene_id");

-- CreateIndex
CREATE INDEX "images_workspace_id_created_at_idx" ON "images"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "images_workspace_id_is_favorite_idx" ON "images"("workspace_id", "is_favorite");

-- CreateIndex
CREATE INDEX "images_file_hash_idx" ON "images"("file_hash");

-- CreateIndex
CREATE UNIQUE INDEX "images_workspace_id_file_hash_key" ON "images"("workspace_id", "file_hash");

-- CreateIndex
CREATE INDEX "image_tags_workspace_id_idx" ON "image_tags"("workspace_id");

-- CreateIndex
CREATE INDEX "image_persons_workspace_id_idx" ON "image_persons"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "prompts_image_id_key" ON "prompts"("image_id");

-- CreateIndex
CREATE INDEX "prompts_workspace_id_idx" ON "prompts"("workspace_id");

-- CreateIndex
CREATE INDEX "prompt_versions_workspace_id_idx" ON "prompt_versions"("workspace_id");

-- CreateIndex
CREATE INDEX "prompt_versions_prompt_id_idx" ON "prompt_versions"("prompt_id");

-- CreateIndex
CREATE INDEX "prompt_versions_prompt_id_created_at_idx" ON "prompt_versions"("prompt_id", "created_at");

-- CreateIndex
CREATE INDEX "upload_sessions_workspace_id_status_idx" ON "upload_sessions"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "upload_sessions_workspace_id_created_at_idx" ON "upload_sessions"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "upload_sessions_user_id_idx" ON "upload_sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "upload_sessions_id_workspace_id_key" ON "upload_sessions"("id", "workspace_id");

-- CreateIndex
CREATE INDEX "upload_items_session_id_idx" ON "upload_items"("session_id");

-- CreateIndex
CREATE INDEX "upload_items_workspace_id_commit_status_idx" ON "upload_items"("workspace_id", "commit_status");

-- CreateIndex
CREATE INDEX "upload_items_session_id_sort_order_idx" ON "upload_items"("session_id", "sort_order");

-- CreateIndex
CREATE INDEX "upload_item_tags_workspace_id_idx" ON "upload_item_tags"("workspace_id");

-- CreateIndex
CREATE INDEX "upload_item_persons_workspace_id_idx" ON "upload_item_persons"("workspace_id");

-- CreateIndex
CREATE INDEX "import_batches_workspace_id_idx" ON "import_batches"("workspace_id");

-- CreateIndex
CREATE INDEX "import_batches_workspace_id_created_at_idx" ON "import_batches"("workspace_id", "created_at");

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "persons" ADD CONSTRAINT "persons_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_groups" ADD CONSTRAINT "prompt_groups_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_groups" ADD CONSTRAINT "prompt_groups_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_groups" ADD CONSTRAINT "prompt_groups_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "images_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "images_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "images" ADD CONSTRAINT "images_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_tags" ADD CONSTRAINT "image_tags_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_tags" ADD CONSTRAINT "image_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_tags" ADD CONSTRAINT "image_tags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_persons" ADD CONSTRAINT "image_persons_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_persons" ADD CONSTRAINT "image_persons_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_persons" ADD CONSTRAINT "image_persons_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_prompt_group_id_fkey" FOREIGN KEY ("prompt_group_id") REFERENCES "prompt_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_items" ADD CONSTRAINT "upload_items_session_id_workspace_id_fkey" FOREIGN KEY ("session_id", "workspace_id") REFERENCES "upload_sessions"("id", "workspace_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_items" ADD CONSTRAINT "upload_items_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_item_tags" ADD CONSTRAINT "upload_item_tags_upload_item_id_fkey" FOREIGN KEY ("upload_item_id") REFERENCES "upload_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_item_tags" ADD CONSTRAINT "upload_item_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_item_tags" ADD CONSTRAINT "upload_item_tags_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_item_persons" ADD CONSTRAINT "upload_item_persons_upload_item_id_fkey" FOREIGN KEY ("upload_item_id") REFERENCES "upload_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_item_persons" ADD CONSTRAINT "upload_item_persons_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_item_persons" ADD CONSTRAINT "upload_item_persons_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
