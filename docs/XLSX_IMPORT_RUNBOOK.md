# XLSX Import Runbook

## 前提

- XLSX ファイルは higgsfield.ai 等の生成結果ファイルを想定
- 各 XLSX シートに画像（embedded）+ プロンプト文字列が含まれる
- シート名 = 人物名として扱う（`--person-from-sheet-name` 使用時）
- 画像は private Storage にアップロードされる

### XLSX の配置場所

```
/Volumes/Extreme SSD/photobox/xlsx/
```

---

## 抽出（extract）

XLSX から画像・プロンプト・メタデータを抽出し、`tmp/xlsx-extract/` に展開する。

### 単一ファイル dry-run

```bash
cd /Volumes/Extreme\ SSD/photobox/app
npm run extract:xlsx-images -- \
  --xlsx "/Volumes/Extreme SSD/photobox/xlsx/ファイル名.xlsx" \
  --dry-run
```

### バッチ dry-run（全 XLSX の確認）

```bash
npm run extract:xlsx-batch -- \
  --xlsx-dir "/Volumes/Extreme SSD/photobox/xlsx" \
  --dry-run
```

### バッチ本実行

```bash
npm run extract:xlsx-batch -- \
  --xlsx-dir "/Volumes/Extreme SSD/photobox/xlsx" \
  --out-root tmp/xlsx-extract
```

- 既存 manifest がある XLSX はデフォルトでスキップ（`--skip-existing` デフォルト true）
- 再抽出する場合は `--no-skip-existing` または `--force`
- 出力: `tmp/xlsx-extract/<xlsx_stem>/manifest.json` + 画像ファイル群

---

## インポート（import）

抽出済み manifest を DB + Storage に取り込む。

### workspace_id の確認

Prisma Studio (`npm run db:studio`) → `workspaces` テーブル、または `/dev/api-check` → A テスト結果で確認。

### 単一 manifest dry-run

```bash
npm run import:xlsx-extract -- \
  --manifest "tmp/xlsx-extract/ファイル名/manifest.json" \
  --workspace-id <workspace_id> \
  --dry-run
```

### 単一 manifest 本実行

```bash
npm run import:xlsx-extract -- \
  --manifest "tmp/xlsx-extract/ファイル名/manifest.json" \
  --workspace-id <workspace_id>
```

### バッチ dry-run（全 manifest の確認）

```bash
npm run import:xlsx-batch -- \
  --workspace-id <workspace_id> \
  --extract-root tmp/xlsx-extract \
  --dry-run
```

### バッチ本実行（推奨オプション）

```bash
npm run import:xlsx-batch -- \
  --workspace-id <workspace_id> \
  --extract-root tmp/xlsx-extract \
  --person-from-sheet-name \
  --scene "XLSX Import" \
  --tags "xlsx-import" \
  --yes
```

- `--person-from-sheet-name`: シート名（人物名）を Person マスタとして自動登録
- `--scene "XLSX Import"`: 全画像に "XLSX Import" シーンを付与
- `--tags "xlsx-import"`: 全画像に "xlsx-import" タグを付与
- `--yes`: 確認プロンプトをスキップ
- `--skip-existing` (デフォルト): 同名 manifest が既に import 済みならスキップ

---

## 追加 XLSX を取り込む場合（Day 10-E 以降）

新しい XLSX を `xlsx/` フォルダに追加したときの手順:

```bash
cd /Volumes/Extreme\ SSD/photobox/app

# 1. 追加ファイルを確認（--only で部分一致フィルタ）
npm run extract:xlsx-batch -- \
  --xlsx-dir "/Volumes/Extreme SSD/photobox/xlsx" \
  --only "新ファイル名の一部" \
  --dry-run

# 2. 抽出実行
npm run extract:xlsx-batch -- \
  --xlsx-dir "/Volumes/Extreme SSD/photobox/xlsx" \
  --only "新ファイル名の一部"

# 3. import dry-run で確認
npm run import:xlsx-batch -- \
  --workspace-id <workspace_id> \
  --only "新ファイル名の一部" \
  --dry-run

# 4. import 本実行
npm run import:xlsx-batch -- \
  --workspace-id <workspace_id> \
  --only "新ファイル名の一部" \
  --person-from-sheet-name \
  --scene "XLSX Import" \
  --tags "xlsx-import" \
  --yes

# 5. storage audit
npm run audit:storage-assets -- \
  --workspace-id <workspace_id> \
  --dry-run

# 6. Gallery で確認
# /gallery?sceneId=<XLSX Import の sceneId>
```

**--only の仕様:**
- 部分一致（大文字小文字区別なし）
- 0件一致: エラー終了
- 複数一致: エラー終了（より具体的な文字列を指定）
- 既存 DONE batch はデフォルトでスキップ（安全）

---

## 15 本程度の XLSX を処理する場合の推奨順序

1. `extract:xlsx-batch --dry-run` で件数・出力パスを確認
2. `extract:xlsx-batch` で一括抽出
3. `import:xlsx-batch --dry-run` で import 件数・重複を確認
4. `import:xlsx-batch --yes` で本実行
5. `audit:storage-assets` で孤立ファイルがないことを確認
6. `/gallery` で画像が表示されることを確認
7. `/masters` で Person / imageCount が正しいことを確認

---

## cleanup:import-batch の使い方

テスト import や失敗した batch を削除する。

```bash
# batch_id は Prisma Studio > import_batches テーブルで確認
npm run cleanup:import-batch -- \
  --import-batch-id <import_batch_id> \
  --dry-run

# 本実行
npm run cleanup:import-batch -- \
  --import-batch-id <import_batch_id> \
  --yes
```

Quick Add 画像（importBatchId なし）は削除されない。

---

## repair:import-duplicates の使い方

別 batch で同一ファイルを再 import した際に発生する `Unique constraint failed` エラーを修正する。

```bash
npm run repair:import-duplicates -- \
  --workspace-id <workspace_id> \
  --extract-root tmp/xlsx-extract \
  --dry-run

npm run repair:import-duplicates -- \
  --workspace-id <workspace_id> \
  --extract-root tmp/xlsx-extract \
  --yes
```

---

## audit:storage-assets の使い方

```bash
# 差分確認のみ（safe）
npm run audit:storage-assets -- --workspace-id <workspace_id>

# 孤立ファイルを削除
npm run audit:storage-assets -- \
  --workspace-id <workspace_id> \
  --cleanup-orphans \
  --yes
```

---

## 失敗時の復旧手順

### import が途中で中断した場合

1. Prisma Studio で `import_batches` テーブルを確認
2. `status = 'PROCESSING'` のままの batch を特定
3. DB 上の該当 batch の Image レコード数を確認
4. 不完全な batch は `cleanup:import-batch` で削除
5. `repair:import-duplicates` で重複エラーを整理
6. 再 import（`--skip-existing` で完了済みはスキップ）

### PROCESSING で止まっている batch の対処

```sql
-- Prisma Studio または Supabase SQL Editor
UPDATE import_batches
SET status = 'FAILED',
    error_log = 'Manual: stuck PROCESSING at <日時>'
WHERE id = '<import_batch_id>';
```

その後 `cleanup:import-batch` で削除して再実行。

### FAILED batch の確認

```sql
SELECT id, xlsx_file_name, status, error_log, created_at
FROM import_batches
WHERE status = 'FAILED'
ORDER BY created_at DESC;
```

---

## 重複画像の扱い

- 同一 `fileHash`（SHA-256）の画像は `duplicateStatus = 'DUPLICATE'` として登録
- Gallery には `status = 'ACTIVE'` の画像のみ表示
- 重複画像は Quick Add の CommitPreview でも検出される

---

## prompt_versions に退避されるケース

- Quick Add でプロンプトを編集した場合
- Import 後にプロンプトを手動編集した場合（将来機能）
- シーン変換を実行した場合（将来機能）

---

## thumbnail / preview 生成仕様

| 種別 | 最大サイズ | 形式 | 用途 |
|---|---|---|---|
| thumbnail | 256px | WebP | Gallery グリッド表示 |
| preview | 1024px | WebP | DetailPanel プレビュー |
| original | 元サイズ | 元形式 | ダウンロード・フル表示 |

signed URL の有効期限：thumbnail 900秒 / preview 600秒 / original 300秒

---

## 全件 import 後の確認 SQL

```sql
-- 総 image 数
SELECT COUNT(*) FROM images
WHERE deleted_at IS NULL AND status = 'ACTIVE';

-- Person ごとの image 数
SELECT p.name, COUNT(ip.image_id) AS count
FROM persons p
LEFT JOIN image_persons ip ON ip.person_id = p.id
LEFT JOIN images i ON i.id = ip.image_id
  AND i.deleted_at IS NULL AND i.status = 'ACTIVE'
GROUP BY p.name
ORDER BY count DESC;

-- ImportBatch の状態
SELECT status, COUNT(*), SUM(total_images), SUM(committed_images)
FROM import_batches
GROUP BY status;

-- thumbnail がない image（Storage アップロード漏れ）
SELECT COUNT(*) FROM images
WHERE thumbnail_path IS NULL
  AND deleted_at IS NULL AND status = 'ACTIVE';
```

---

## Gallery 確認手順（import 後）

1. `/gallery` を開く
2. Tag フィルタで `xlsx-import` を選択 → 画像が表示される
3. Scene フィルタで `XLSX Import` を選択 → 画像が表示される
4. Person フィルタで人物名を選択 → その人物の画像が表示される
5. `/masters` で Person の imageCount が 0 より大きいことを確認
6. 画像をクリック → DetailPanel が開き signed URL で画像が表示される
