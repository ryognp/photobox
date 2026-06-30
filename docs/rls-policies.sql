-- ================================================================
-- Photobox — RLS Policies
-- Supabase Dashboard > SQL Editor でこのファイルを実行してください
-- ================================================================
-- 方針:
--   INSERT / UPDATE / DELETE は API Route (service role) からのみ実行
--   SELECT は RLS で workspace メンバーのみに制限
--   Storage は client direct access 禁止（bucket policy 側で設定）
-- ================================================================

-- ----------------------------------------------------------------
-- workspaces
-- ----------------------------------------------------------------
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select workspaces"
  ON workspaces FOR SELECT
  USING (
    id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- workspace_members
-- ----------------------------------------------------------------
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members can see own membership"
  ON workspace_members FOR SELECT
  USING (user_id = auth.uid()::text);

-- ----------------------------------------------------------------
-- images
-- ----------------------------------------------------------------
ALTER TABLE images ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select images"
  ON images FOR SELECT
  USING (
    deleted_at IS NULL
    AND workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- image_tags
-- ----------------------------------------------------------------
ALTER TABLE image_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select image_tags"
  ON image_tags FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- image_persons
-- ----------------------------------------------------------------
ALTER TABLE image_persons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select image_persons"
  ON image_persons FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- scenes
-- ----------------------------------------------------------------
ALTER TABLE scenes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select scenes"
  ON scenes FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- tags
-- ----------------------------------------------------------------
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select tags"
  ON tags FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- persons
-- ----------------------------------------------------------------
ALTER TABLE persons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select persons"
  ON persons FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- prompt_groups
-- ----------------------------------------------------------------
ALTER TABLE prompt_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select prompt_groups"
  ON prompt_groups FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- prompts
-- ----------------------------------------------------------------
ALTER TABLE prompts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select prompts"
  ON prompts FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- prompt_versions
-- ----------------------------------------------------------------
ALTER TABLE prompt_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select prompt_versions"
  ON prompt_versions FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- upload_sessions (作成者のみ)
-- ----------------------------------------------------------------
ALTER TABLE upload_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner can select upload_sessions"
  ON upload_sessions FOR SELECT
  USING (user_id = auth.uid()::text);

-- ----------------------------------------------------------------
-- upload_items
-- ----------------------------------------------------------------
ALTER TABLE upload_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select upload_items"
  ON upload_items FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- upload_item_tags
-- ----------------------------------------------------------------
ALTER TABLE upload_item_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select upload_item_tags"
  ON upload_item_tags FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- upload_item_persons
-- ----------------------------------------------------------------
ALTER TABLE upload_item_persons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select upload_item_persons"
  ON upload_item_persons FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ----------------------------------------------------------------
-- import_batches
-- ----------------------------------------------------------------
ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workspace_members can select import_batches"
  ON import_batches FOR SELECT
  USING (
    workspace_id IN (
      SELECT workspace_id FROM workspace_members
      WHERE user_id = auth.uid()::text
    )
  );

-- ================================================================
-- Storage bucket policy
-- Supabase Dashboard > Storage > photobox-private > Policies で設定
-- ================================================================
-- 以下の SQL は Storage policy の参考。
-- Dashboard の GUI または SQL で設定してください。

-- client からの直接アクセスを禁止（service role のみ許可）
-- INSERT policy: 設定しない（= 誰も client からは書けない）
-- SELECT policy: 設定しない（= 誰も client からは読めない）
-- signed URL は API Route の service role key で発行

-- ※ Supabase の Storage は bucket RLS を設定しない場合、
--   authenticated user が読み書きできてしまうため、
--   bucket の "Public" が OFF であることを必ず確認すること
