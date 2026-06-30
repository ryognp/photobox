# Photobox — 運用手順

## 開発サーバー起動

```bash
cd /Volumes/Extreme\ SSD/photobox/app
npm run dev
# → http://localhost:3007
```

## 停止中プロセスの確認・kill

```bash
# port 3007 を使っているプロセスを確認
lsof -i :3007

# kill
lsof -ti :3007 | xargs kill -9
```

---

## DB 操作

### schema validate

```bash
npm run db:validate
```

### migrate (dev)

`.env.migrate` に `DIRECT_URL`（Session Mode, port 5432）が必要。

```bash
npm run db:migrate
# 新しい migration ファイルが生成される
# prisma client も自動再生成される
```

### migrate (production deploy)

```bash
npm run db:migrate:prod
```

### Prisma client 再生成のみ

```bash
npm run db:generate
```

### Prisma Studio（GUI でテーブル確認）

```bash
npm run db:studio
# http://localhost:5555
```

---

## RLS (Row Level Security)

現在の設計では **RLS は無効**、サーバー側の service_role client + API Route での workspace 権限チェックで代替。

- API Route 内で `workspaceId` が一致するレコードのみアクセス
- `request.body` の `workspaceId` / `userId` は信用しない（必ず auth から取得）

将来 RLS を有効化する場合は全 table に対して policy を作成する必要がある。

---

## Supabase Storage

### bucket 確認

Supabase Dashboard → **Storage** → `photobox-private` バケットが存在し **private** であること。

### 孤立ファイル (orphan) の確認

```bash
# dry-run: 差分確認のみ
npm run audit:storage-assets -- --workspace-id <workspace_id>

# 削除実行
npm run audit:storage-assets -- --workspace-id <workspace_id> --cleanup-orphans

# 確認なしで削除
npm run audit:storage-assets -- --workspace-id <workspace_id> --cleanup-orphans --yes
```

workspace_id は Supabase Studio の `workspaces` テーブル、または `/dev/api-check` の A テスト結果から確認できる。

---

## service_role key の扱い

- Supabase Dashboard → **Settings → API → service_role** からのみ取得
- `.env.local` にのみ保存（git commit 禁止）
- `NEXT_PUBLIC_` prefix を付けない
- チャット・GitHub・Slack に貼らない
- クライアントコード（`"use client"` / ブラウザ側）に書かない
- 漏洩した場合は即 Regenerate する

---

## dev 確認手順（デプロイ前）

```bash
cd /Volumes/Extreme\ SSD/photobox/app
npm run lint
npm run build
npm run db:validate
```

ブラウザで以下を順に確認：

1. `/login` — ログインできる
2. `/quick-add` — 画像をアップロードできる
3. `/quick-add/commit` — CommitPreview が表示される
4. `/gallery` — 画像一覧が表示される（628件以上）
5. `/masters` — Person / Scene / Tag が表示される
6. `/import` — XLSX を drop できる（parse のみ）
7. `/dev/api-check` — 主要テストが PASS

---

## /dev/api-check の使い方

`http://localhost:3007/dev/api-check`（development only）

- **マスタ API (A〜J)**: Person / Scene / Tag の CRUD
- **Upload Session (K〜R)**: セッション作成・更新・破棄
- **Upload Item (S〜Y)**: 画像アップロード・重複チェック
- **Prompt / Metadata (Z〜AH)**: プロンプト・メタデータ操作
- **CommitPreview (AI〜AQ)**: 確定前確認
- **Gallery API (AR〜AU)**: 画像一覧・詳細
- **Cleanup (AV〜AX)**: 未コミット session 削除
- **Import (AY〜BA)**: XLSX parse
- **Gallery Detail / Filter / Search (BI〜BO)**: フィルタ・検索・詳細
- **Prompt Versions (BP〜BR)**: 履歴確認
- **Masters 管理 (BS〜BY)**: Masters API・PATCH・imageCount

AX（cleanup 本実行）は注意して実行すること。

---

## import 後の Storage audit 手順

XLSX batch import 後は必ず audit を実施して孤立ファイルがないことを確認する。

```bash
# 1. workspace_id を確認（Prisma Studio または /dev/api-check テスト A の結果）
# 2. dry-run で差分確認
npm run audit:storage-assets -- --workspace-id <id>

# 3. 孤立があれば内容を確認してから削除
npm run audit:storage-assets -- --workspace-id <id> --cleanup-orphans
```

---

## cleanup API の使い方

古い未コミット Upload Session を削除する。

### 確認（dry-run）

```bash
curl -X POST http://localhost:3007/api/uploads/cleanup \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

または `/dev/api-check` → AV テスト。

### 実行

```bash
curl -X POST http://localhost:3007/api/uploads/cleanup \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false}'
```

または `/dev/api-check` → AX テスト。

---

## 定期的に確認する SQL（Prisma Studio / Supabase SQL Editor）

```sql
-- 未コミット session 数
SELECT status, COUNT(*) FROM upload_sessions GROUP BY status;

-- PROCESSING / FAILED の ImportBatch
SELECT id, status, xlsx_file_name, created_at, error_log
FROM import_batches
WHERE status IN ('PROCESSING', 'FAILED')
ORDER BY created_at DESC;

-- orphan upload_items（3日以上前の未コミット）
SELECT COUNT(*) FROM upload_items ui
JOIN upload_sessions us ON us.id = ui.session_id
WHERE us.status NOT IN ('COMMITTED')
  AND us.created_at < NOW() - INTERVAL '3 days';

-- workspace の image 数
SELECT workspace_id, COUNT(*) FROM images
WHERE deleted_at IS NULL AND status = 'ACTIVE'
GROUP BY workspace_id;
```

---

## トラブル時の初動

### /gallery が開かない

1. dev server が起動しているか確認 → `npm run dev`
2. ブラウザのネットワークタブで API エラーを確認
3. `/api/images` の status code を確認（401 = 未ログイン、500 = サーバーエラー）
4. `.env.local` の `DATABASE_URL` が正しいか確認

### /api/images が 500

1. Supabase プロジェクトが起動中か確認（Dashboard → 緑ランプ）
2. `DATABASE_URL` の接続先が正しいか確認
3. `SUPABASE_SERVICE_ROLE_KEY` が有効か確認（Dashboard → API → service_role）
4. `npm run dev` のコンソールエラーを確認

### Storage orphan が出る

```bash
npm run audit:storage-assets -- --workspace-id <id>
```

で孤立ファイル一覧を確認し、必要なら `--cleanup-orphans` で削除。

### ImportBatch が PROCESSING で止まる

```sql
-- PROCESSING のまま止まっている batch を FAILED に更新
UPDATE import_batches
SET status = 'FAILED', error_log = 'Manual intervention: stuck PROCESSING'
WHERE id = '<import_batch_id>';
```

その後 `cleanup:import-batch` で不完全データを削除し、再 import する。

---

## セキュリティチェックリスト

- [ ] `.env.local` が git に含まれていない
- [ ] `SUPABASE_SERVICE_ROLE_KEY` がクライアントコードに含まれていない
- [ ] `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` が存在しない
- [ ] Storage bucket が private であること
- [ ] signed URL 以外で画像を公開していない
- [ ] RLS 無効の代わりに API Route での workspace 権限チェックが実装されている
