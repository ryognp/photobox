# 最終 QA チェックリスト

リリース前・大きな Import 後・機能追加後に実施する最終確認。

実施日: ____/__/__
担当: ________

---

## A. 起動確認

```bash
cd "/Volumes/Extreme SSD/photobox/app"
npm run dev
```

| 確認項目 | 結果 |
|---|---|
| dev server が port 3007 で起動する | [ ] |
| `/login` が開ける | [ ] |
| `/quick-add` が開ける（要ログイン） | [ ] |
| `/gallery` が開ける（要ログイン） | [ ] |
| `/masters` が開ける（要ログイン） | [ ] |
| `/import` が開ける（要ログイン） | [ ] |
| `/dev/api-check` が開ける（development only） | [ ] |

---

## B. Auth / Workspace

| 確認項目 | 結果 |
|---|---|
| `/login` でログインできる | [ ] |
| `/quick-add` に自分の email と workspace が表示される | [ ] |
| 未ログイン状態で `/gallery` にアクセスすると `/login` にリダイレクトされる | [ ] |
| `/signup` で新規アカウントを作成できる | [ ] |

---

## C. Quick Add

| 確認項目 | 結果 |
|---|---|
| 画像 1 枚をドラッグ&ドロップでアップロードできる | [ ] |
| サムネイルプレビューが表示される | [ ] |
| Prompt を入力できる | [ ] |
| 「入力済みにする」チェックが動く | [ ] |
| Scene / Tag / Person / Notes を設定できる | [ ] |
| 「プレビューへ進む」で `/quick-add/commit` に移動する | [ ] |
| CommitPreview で重複チェックが動く | [ ] |
| 「確定」で Gallery に画像が追加される | [ ] |
| 確定後 `/gallery` に移動できる | [ ] |

---

## D. Gallery

| 確認項目 | 確認方法 | 結果 |
|---|---|---|
| 初期表示が 48件程度 | ページ下部の件数表示 | [ ] |
| 「もっと読み込む」で追加ロードされる | ページ最下部のボタン | [ ] |
| サムネイルクリックで DetailPanel が開く | 任意の画像をクリック | [ ] |
| 英語 Prompt が DetailPanel に表示される | Prompt 欄 | [ ] |
| Notes が DetailPanel に表示される | notes 欄 | [ ] |
| thumbnail が表示される | 画像カード | [ ] |
| preview が DetailPanel で表示される | 画像プレビュー欄 | [ ] |
| Person フィルタで絞り込める | 「凛(Rin)」を選択 | [ ] |
| Scene フィルタで絞り込める | 「XLSX Import」を選択 | [ ] |
| Tag フィルタで絞り込める | 「xlsx-import」を選択 | [ ] |
| テキスト検索が動く | 検索バーに任意のワード入力 | [ ] |
| フィルタ解除が動く | 選択フィルタの「×」 | [ ] |
| 「履歴 N」バッジがある画像で Prompt Versions が表示される | prompt_versions ある画像を選択 | [ ] |
| Prompt コピーボタンが動く | 「コピー」クリック | [ ] |

---

## E. Masters

| 確認項目 | 確認方法 | 結果 |
|---|---|---|
| Persons タブに「凛(Rin)」が表示される | Persons タブ | [ ] |
| 凛(Rin) の imageCount > 0 | imageCount 列 | [ ] |
| Scenes タブに「XLSX Import」が表示される | Scenes タブ | [ ] |
| XLSX Import の imageCount > 0 | imageCount 列 | [ ] |
| Tags タブに「xlsx-import」が表示される | Tags タブ | [ ] |
| xlsx-import の imageCount > 0 | imageCount 列 | [ ] |
| 新規マスタを作成できる（テスト用の名前で） | 「＋ 追加」ボタン | [ ] |
| 名前を編集できる | 「編集」ボタン | [ ] |
| 「Gallery で絞り込む」リンクで Gallery が開く | リンククリック | [ ] |
| `/dev/api-check` BS〜BY が PASS | api-check ページ | [ ] |

---

## F. Import / CLI

```bash
cd "/Volumes/Extreme SSD/photobox/app"
```

| 確認項目 | コマンド | 結果 |
|---|---|---|
| extract dry-run が動く | `npm run extract:xlsx-batch -- --xlsx-dir "/Volumes/Extreme SSD/photobox/xlsx" --dry-run` | [ ] |
| extract 本実行が動く | `npm run extract:xlsx-batch -- --xlsx-dir "..." --out-root tmp/xlsx-extract` | [ ] |
| import dry-run が動く | `npm run import:xlsx-batch -- --workspace-id <id> --extract-root tmp/xlsx-extract --dry-run` | [ ] |
| repair:import-duplicates dry-run | `npm run repair:import-duplicates -- --workspace-id <id> --extract-root tmp/xlsx-extract --dry-run` | [ ] |
| audit:storage-assets が動く | `npm run audit:storage-assets -- --workspace-id <id>` | [ ] |
| Storage orphan 0 件 | audit 結果 | [ ] |
| Storage missing 0 件 | audit 結果 | [ ] |

---

## G. Database

> **注意**: 以下の期待値は **2026-06-30 時点のローカル環境のスナップショット** です。
> Import 追加・cleanup・Quick Add 追加などで変動します。固定仕様値ではありません。

Prisma Studio または Supabase SQL Editor で確認。

```sql
-- images 総数
SELECT COUNT(*) FROM images
WHERE deleted_at IS NULL AND status = 'ACTIVE';
-- 期待値: 628

-- prompts 総数
SELECT COUNT(*) FROM prompts;
-- 期待値: 628

-- prompt_versions 総数
SELECT COUNT(*) FROM prompt_versions;
-- 期待値: 2

-- image_tags: xlsx-import
SELECT COUNT(*) FROM image_tags it
JOIN tags t ON t.id = it.tag_id
WHERE t.name = 'xlsx-import';
-- 期待値: 627

-- image_persons: 凛(Rin)
SELECT COUNT(*) FROM image_persons ip
JOIN persons p ON p.id = ip.person_id
WHERE p.name = '凛(Rin)';
-- 期待値: 627

-- import_batches の状態
SELECT status, COUNT(*), SUM(total_images), SUM(committed_images), SUM(error_count)
FROM import_batches
GROUP BY status;
-- 期待値: DONE 9件, error_count合計 0

-- PROCESSING / FAILED batch（0 件であること）
SELECT id, xlsx_file_name, status, error_log, created_at
FROM import_batches
WHERE status IN ('PROCESSING', 'FAILED');
```

| 確認項目 | 期待値 | 結果 |
|---|---|---|
| images COUNT | 628 | [ ] |
| prompts COUNT | 628 | [ ] |
| prompt_versions COUNT | 2 | [ ] |
| image_tags: xlsx-import | 627 | [ ] |
| image_persons: 凛(Rin) | 627 | [ ] |
| import_batches DONE | 9件 | [ ] |
| import_batches error_count 合計 | 0 | [ ] |
| PROCESSING / FAILED batch | 0件 | [ ] |

---

## H. Storage

| 確認項目 | 確認方法 | 結果 |
|---|---|---|
| bucket `photobox-private` が存在する | Supabase Dashboard → Storage | [ ] |
| bucket が **private** である | Supabase Dashboard → Storage → bucket 設定 | [ ] |
| original / thumbnail / preview ファイルが存在する | Supabase Dashboard → Storage → ファイル確認 | [ ] |
| audit: missing 0件 | `npm run audit:storage-assets -- --workspace-id <id>` | [ ] |
| audit: orphan 0件 | 同上 | [ ] |

---

## I. セキュリティ

```bash
# service_role key がクライアントコードに混入していないか
grep -r "SUPABASE_SERVICE_ROLE_KEY" /Volumes/Extreme\ SSD/photobox/app/src \
  --include="*.tsx" --include="*.ts" | grep -v "server-only"

# NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY が存在しないか
grep -r "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY" /Volumes/Extreme\ SSD/photobox/app/

# .env.local が git に含まれていないか
git -C /Volumes/Extreme\ SSD/photobox/app status | grep ".env.local"

# docs に実シークレットが混入していないか
grep -R -nE "sb_secret_|SUPABASE_SERVICE_ROLE_KEY=.*eyJ" \
  /Volumes/Extreme\ SSD/photobox/README.md \
  /Volumes/Extreme\ SSD/photobox/docs/
```

| 確認項目 | 結果 |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` がクライアントコードにない | [ ] |
| `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` が存在しない | [ ] |
| `.env.local` が git に含まれていない | [ ] |
| `tmp/xlsx-extract/` が git に含まれていない | [ ] |
| Storage bucket `photobox-private` が private | [ ] |
| docs に実シークレットが混入していない | [ ] |

---

## J. 静的チェック

```bash
cd "/Volumes/Extreme SSD/photobox/app"
npm run lint
npm run build
npm run db:validate
```

| チェック | 結果 |
|---|---|
| `npm run lint` — 0 errors | [ ] |
| `npm run build` — 成功 | [ ] |
| `npm run db:validate` — schema valid | [ ] |

---

## メモ欄

```
実施日:
確認者:
問題点:
対応内容:
次回確認予定:
```
