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

## 画像処理と対応フォーマット

### 対応フォーマット

- アップロード可能なのは **JPEG / PNG / WebP のみ**（`src/lib/upload/validateImage.ts`：
  content-type + magic bytes の両方で検証。dropzone も同3種のみ受理）。
- **HEIC / HEIF は現状非対応**。iPhone 等の HEIC 画像は **JPEG/PNG/WebP に変換してから**
  アップロードする（ユーザー向け案内は [USER_MANUAL.md](USER_MANUAL.md) にも記載）。
- 将来 HEIC 対応する場合の候補はクライアント変換（例: `heic2any`）。品質・EXIF・
  ファイルサイズ・ブラウザ互換性を検証してから導入する。ブラウザ標準 decode や
  サーバー変換（libheif）は重いため現時点では見送り。

### sharp 依存（削除不可）

- `sharp` は**本番 API では未使用**だが、**XLSX / import 系スクリプトで現役使用中**のため
  **削除してはいけない**：
  - `scripts/_lib/imgVariants.ts`（metadata 取得・resize・WebP 生成）
  - `scripts/import-xlsx-run.ts`（`sharp(buf).resize(...).webp(...).toBuffer()` で variant 生成）
- 依存整理（例: `@types/sharp` の重複）を行う場合は別タスクとし、`npm run build` と
  import スクリプトの dry-run まで確認してから行うこと。

### 派生画像の生成場所

- Quick Add（Web アップロード）: thumbnail/preview はすべて**クライアント Canvas**で生成。
  original はサーバーで raw bytes のまま保存（再エンコードなし）。
- XLSX バッチ取込: thumbnail/preview は**サーバー側 sharp**で生成。original は保存のみ。
- EXIF/GPS の扱いは [SECURITY.md](SECURITY.md) の「画像プライバシー」節を参照。

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

## 画像削除（Image delete Phase 1）

- `DELETE /api/images/[id]` は **soft delete のみ**行う。
- `images.status = DELETED`, `images.deletedAt = now` に更新する。
- **Storage object は Phase 1 では削除しない**（後続の cleanup/audit 系タスクで扱う）。
- 発行済み signed URL は TTL（最大 ~15分）まで有効な場合がある。
- prompt / promptVersions / imageTags / imagePersons は soft delete のため温存される（物理 delete しない）。
- 既に削除済みの画像に対する DELETE は idempotent に 200 を返す（`alreadyDeleted: true`）。
- UI: Gallery 詳細パネル（desktop/mobile）に削除ボタン。削除後は一覧から即除去しパネルを閉じる。

### soft delete 後の同一 fileHash 再アップロード（Phase 6C で解決済み）

**解決済み。** `(workspace_id, file_hash)` の一意性は **partial unique index** で
「生存画像のみ」に限定される（migration `*_partial_unique_filehash`）:

```sql
DROP INDEX IF EXISTS "images_workspace_id_file_hash_key";
CREATE UNIQUE INDEX "idx_images_workspace_file_hash_not_deleted_unique"
ON "images" ("workspace_id", "file_hash")
WHERE "deleted_at" IS NULL AND "status" <> 'DELETED';
```

これにより、soft delete 済み画像は一意空間を占有せず、**同じ画像を削除後に再アップロード可能**。
生存画像同士の重複アップロードは引き続き拒否される。Prisma schema では partial index を
表現できないため、`@@unique([workspaceId, fileHash])` は schema から外し、この index は
migration で管理する（`@@index([fileHash])` は検索用に保持）。

Phase 6A で入れた整合・緩和（統一された重複判定、commit の P2002 明示化、import の
P2002 recovery）はそのまま有効。partial index 導入後は、生存画像に重複が無い限り
commit/import で P2002 自体が発生しなくなる。

#### 本番適用前チェック（必須）

partial unique index の作成は、**既に生存画像同士で同一 `(workspace_id, file_hash)` の
重複が存在すると失敗する**。適用前に本番 DB で以下を実行し、**0 rows** を確認すること:

```sql
SELECT workspace_id, file_hash, COUNT(*) AS cnt
FROM images
WHERE deleted_at IS NULL AND status <> 'DELETED'
GROUP BY workspace_id, file_hash
HAVING COUNT(*) > 1;
```

0 rows なら `npm run db:migrate:prod` 実行可。1行でも出たら先に重複解消が必要。

#### rollback

```sql
DROP INDEX IF EXISTS "idx_images_workspace_file_hash_not_deleted_unique";
CREATE UNIQUE INDEX "images_workspace_id_file_hash_key"
ON "images" ("workspace_id", "file_hash");
```

※ plain unique へ戻す際、**生存でない重複（削除済み含む全行）で衝突があると再作成に失敗**する。
必要なら先に重複解消する。schema 側も `@@unique([workspaceId, fileHash])` を戻すこと。

#### Prisma 7.8 での drift 確認コマンド

`migrate diff` は Prisma 7.8 で `--from-url` が廃止。DB 実体 vs schema の drift 確認は:

```bash
# DB(datasource) を基準に schema への差分を見る（空 = drift なし）
dotenv -e <env> -- npx prisma migrate diff \
  --from-config-datasource --to-schema prisma/schema.prisma --exit-code
# exit code: 0=空(drift なし) / 2=差分あり / 1=エラー
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

上記のユーザー向け `/api/uploads/cleanup` は「自分の workspace の自分のセッション」のみ対象。
全 workspace を横断する自動清掃は下記の cron が担当する。

---

## cleanup cron（自動清掃）

`GET /api/cron/cleanup-uploads` — 全 workspace の古い未コミット Upload Session を清掃する。
Vercel Cron が **6時間ごと**（`0 */6 * * *`, `vercel.json` の `crons`）に自動実行する。

### 認証

- `CRON_SECRET` 環境変数（サーバー専用）で保護。fail-CLOSED（未設定 or 不一致は 401）。
- Vercel Cron は `CRON_SECRET` が設定されていれば自動で
  `Authorization: Bearer ${CRON_SECRET}` を付けて呼ぶ。
- Vercel ダッシュボード（Settings → Environment Variables）で `CRON_SECRET` に
  十分に長いランダム値を設定すること。未設定だと cron は 401 で何もしない。

### 動作の安全性

- COMMITTED session は対象外。さらに **COMMITTED item を1つでも含む session も
  丸ごと対象外**（異常・中間状態として保持し、manual audit 対象にする）。
  除外件数は `skippedCommittedMixedSessions` として返す。
- **temp storage の削除が成功したセッションだけ** DB レコードを物理削除する。
  storage 削除が失敗したセッションは DB を残し、次回実行で再試行する
  （「DB だけ消えてファイルが孤児化」を防ぐ）。
- 1回あたり最大 200 セッション処理（cron が高頻度なので順次消化される）。
- 実行結果に `deletedSessions` / `retainedSessions` / `deletedStoragePaths` /
  `warnings` を返し、warning があれば server log にも出す。

### 手動テスト（デプロイ後）

```bash
# dry-run（削除せず対象数のみ確認）
curl "https://<app>/api/cron/cleanup-uploads?dryRun=1" \
  -H "Authorization: Bearer ${CRON_SECRET}"

# 実行
curl "https://<app>/api/cron/cleanup-uploads" \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

`olderThanHours`（1〜168、既定 24）でカットオフ時間を調整可能。

### 孤児ファイルの監査

cron は「DB に紐づく古い temp セッション」を清掃するが、
DB 参照が既に無い storage 上の孤児ファイルは対象外。
その監査・削除は `npm run audit:storage-assets`（[SCRIPTS.md](SCRIPTS.md)）で行う。
下記「import 後の Storage audit 手順」も参照。

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
