# Photobox — npm scripts 詳細

すべてのコマンドは `/Volumes/Extreme SSD/photobox/app` で実行する。

---

## 危険度分類

| 分類 | 意味 |
|---|---|
| 🟢 **SAFE** | DB・Storage を変更しない。何度実行しても安全。 |
| 🟡 **WRITES DATA** | DB・Storage に書き込む。dry-run で事前確認必須。 |
| 🔴 **DELETES DATA** | DB レコードまたは Storage ファイルを**削除**する。元に戻せない。 |
| 🟠 **REPAIRS DATA** | DB のエラーログ等を上書き修正する。意図した batch にのみ実行する。 |

---

## 危険度クイックリファレンス

| script | 危険度 | DB書換 | Storage書換 | dry-run |
|---|---|---|---|---|
| `npm run lint` | 🟢 SAFE | ✗ | ✗ | — |
| `npm run build` | 🟢 SAFE | ✗ | ✗ | — |
| `npm run db:validate` | 🟢 SAFE | ✗ | ✗ | — |
| `npm run db:generate` | 🟢 SAFE | ✗ | ✗ | — |
| `npm run db:studio` | 🟢 SAFE※ | GUI次第 | ✗ | — |
| `npm run extract:xlsx-images` | 🟢 SAFE | ✗ | ✗ | あり |
| `npm run extract:xlsx-batch` | 🟢 SAFE | ✗ | ✗ | あり |
| `npm run audit:storage-assets`（オプションなし） | 🟢 SAFE | ✗ | ✗ | デフォルト |
| `npm run db:migrate` | 🟡 WRITES DATA | DDL変更 | ✗ | なし |
| `npm run db:migrate:prod` | 🟡 WRITES DATA | DDL変更 | ✗ | なし |
| `npm run import:xlsx-run` | 🟡 WRITES DATA | ✓ | ✓ | あり |
| `npm run import:xlsx-extract` | 🟡 WRITES DATA | ✓ | ✓ | あり |
| `npm run import:xlsx-batch` | 🟡 WRITES DATA | ✓ | ✓ | あり |
| `npm run repair:import-duplicates` | 🟠 REPAIRS DATA | error_log上書 | ✗ | あり |
| `npm run cleanup:import-batch` | 🔴 DELETES DATA | ✓ | ✓ | あり |
| `npm run audit:storage-assets --cleanup-orphans` | 🔴 DELETES DATA | ✗ | ✓ | あり |

---

## 開発・ビルド

### `npm run dev` 🟢 SAFE

**何をするか**: 開発サーバーを起動する（webpack mode, port 3007）。

```bash
npm run dev
# → http://localhost:3007
```

- **DB を書き換えるか**: しない
- **Storage を書き換えるか**: しない
- **dry-run**: 該当なし
- **実行前に確認**: `.env.local` が存在すること
- **失敗時の戻し方**: port 3007 が使用中なら `lsof -ti :3007 | xargs kill -9` してから再実行
- **注意**: Turbopack は現在無効（`--webpack` フラグ）

---

### `npm run build` 🟢 SAFE

**何をするか**: 本番ビルドを実行する。TypeScript 型チェックと静的解析が走る。

```bash
npm run build
```

- **DB を書き換えるか**: しない
- **Storage を書き換えるか**: しない
- **dry-run**: 該当なし
- **実行前に確認**: 特になし
- **失敗時の戻し方**: TypeScript エラーを確認して修正する

---

### `npm run lint` 🟢 SAFE

**何をするか**: ESLint を実行する。

```bash
npm run lint
```

- **DB を書き換えるか**: しない
- **Storage を書き換えるか**: しない
- **dry-run**: 該当なし
- **実行前に確認**: 特になし
- **失敗時の戻し方**: エラーメッセージに従って修正する

---

## DB 操作

### `npm run db:validate` 🟢 SAFE

**何をするか**: Prisma schema の構文チェック。DB 接続不要。

```bash
npm run db:validate
```

- **DB を書き換えるか**: しない（接続すらしない）
- **Storage を書き換えるか**: しない
- **dry-run**: 常に dry-run 相当
- **実行前に確認**: 特になし
- **失敗時の戻し方**: schema.prisma の構文エラーを修正する

---

### `npm run db:migrate` 🟡 WRITES DATA

**何をするか**: 新しい migration を作成し dev DB に適用する（development 専用）。

```bash
npm run db:migrate
```

- **DB を書き換えるか**: する（DDL 変更 — テーブル追加・カラム追加等）
- **Storage を書き換えるか**: しない
- **dry-run**: なし
- **実行前に確認**:
  - `.env.migrate` に `DIRECT_URL`（Session Mode port 5432）が設定されていること
  - schema.prisma の変更内容を意図通りに確認してから実行
- **失敗時の戻し方**: 生成された migration ファイルを削除して `db:generate` を再実行。または migration を手動で rollback する（`prisma migrate resolve --rolled-back <migration_name>`）

---

### `npm run db:migrate:prod` 🟡 WRITES DATA

**何をするか**: 既存の migration を本番 DB に適用する。

```bash
npm run db:migrate:prod
```

- **DB を書き換えるか**: する（DDL 変更のみ、データ削除は発生しない）
- **Storage を書き換えるか**: しない
- **dry-run**: なし
- **実行前に確認**:
  - Supabase Dashboard で DB バックアップを確認・取得してから実施
  - `.env.migrate` に**本番** `DIRECT_URL` が設定されていること
  - `npm run db:validate` が成功していること
- **失敗時の戻し方**: Supabase Dashboard → Database → Backups からリストア

---

### `npm run db:generate` 🟢 SAFE

**何をするか**: Prisma client を再生成する（schema 変更後に使用）。

```bash
npm run db:generate
```

- **DB を書き換えるか**: しない
- **Storage を書き換えるか**: しない
- **dry-run**: 該当なし
- **実行前に確認**: 特になし
- **失敗時の戻し方**: schema.prisma の構文を確認する

---

### `npm run db:studio` 🟢 SAFE※

**何をするか**: Prisma Studio を起動する（http://localhost:5555）。GUI でテーブルを閲覧・編集できる。

```bash
npm run db:studio
```

- **DB を書き換えるか**: GUI から手動で変更できる（誤操作に注意）
- **Storage を書き換えるか**: しない
- **dry-run**: 該当なし
- **実行前に確認**: 本番 DB に接続している場合は読み取りのみを意識する
- **失敗時の戻し方**: 誤ってレコードを変更した場合は Supabase Dashboard からロールバック

---

## XLSX 抽出

### `npm run extract:xlsx-images` 🟢 SAFE

**何をするか**: 単一の XLSX ファイルから画像を抽出し、`tmp/xlsx-extract/<name>/` にローカル展開する。

```bash
# dry-run（展開せずに内容確認のみ）
npm run extract:xlsx-images -- \
  --xlsx "/Volumes/Extreme SSD/photobox/xlsx/ファイル名.xlsx" \
  --dry-run

# 本実行
npm run extract:xlsx-images -- \
  --xlsx "/Volumes/Extreme SSD/photobox/xlsx/ファイル名.xlsx" \
  --out-dir tmp/xlsx-extract/ファイル名
```

- **DB を書き換えるか**: しない
- **Storage を書き換えるか**: しない（ローカルファイルのみ）
- **dry-run**: あり（`--dry-run`）
- **実行前に確認**: XLSX パスが正しいこと
- **失敗時の戻し方**: `tmp/xlsx-extract/<name>/` を削除して再実行（DB・Storage に影響なし）

---

### `npm run extract:xlsx-batch` 🟢 SAFE

**何をするか**: ディレクトリ内のすべての XLSX を一括抽出する。

```bash
# dry-run
npm run extract:xlsx-batch -- \
  --xlsx-dir "/Volumes/Extreme SSD/photobox/xlsx" \
  --dry-run

# 本実行
npm run extract:xlsx-batch -- \
  --xlsx-dir "/Volumes/Extreme SSD/photobox/xlsx" \
  --out-root tmp/xlsx-extract

# 再抽出（既存スキップを無効化）
npm run extract:xlsx-batch -- \
  --xlsx-dir "/Volumes/Extreme SSD/photobox/xlsx" \
  --out-root tmp/xlsx-extract \
  --no-skip-existing
```

- **DB を書き換えるか**: しない
- **Storage を書き換えるか**: しない
- **dry-run**: あり（`--dry-run`）
- **実行前に確認**: xlsx ディレクトリのパスが正しいこと
- **失敗時の戻し方**: `tmp/xlsx-extract/` を削除して再実行（DB・Storage に影響なし）
- **注意**: `._*.xlsx` 等の macOS 隠しファイルは自動スキップ

---

## XLSX インポート

### `npm run import:xlsx-run` 🟡 WRITES DATA

**何をするか**: XLSX ファイルを extract なしで直接 import する（単一ファイル向け簡易コマンド）。

```bash
# dry-run
npm run import:xlsx-run -- \
  --xlsx "/Volumes/Extreme SSD/photobox/xlsx/ファイル名.xlsx" \
  --workspace-id <workspace_id> \
  --dry-run

# 本実行
npm run import:xlsx-run -- \
  --xlsx "/Volumes/Extreme SSD/photobox/xlsx/ファイル名.xlsx" \
  --workspace-id <workspace_id>
```

- **DB を書き換えるか**: する（Image・ImportBatch・Person/Scene/Tag レコード追加）
- **Storage を書き換えるか**: する（thumbnail / preview / original をアップロード）
- **dry-run**: あり（`--dry-run`）
- **実行前に確認**:
  1. workspace_id が正しいこと（Prisma Studio または `/dev/api-check` A テストで確認）
  2. dry-run で件数を確認してから本実行
- **失敗時の戻し方**: `cleanup:import-batch` に失敗 batch の ID を渡して削除する

---

### `npm run import:xlsx-extract` 🟡 WRITES DATA

**何をするか**: 抽出済み manifest.json を 1 件 import する。

```bash
# dry-run
npm run import:xlsx-extract -- \
  --manifest "tmp/xlsx-extract/ファイル名/manifest.json" \
  --workspace-id <workspace_id> \
  --dry-run

# 本実行
npm run import:xlsx-extract -- \
  --manifest "tmp/xlsx-extract/ファイル名/manifest.json" \
  --workspace-id <workspace_id>
```

- **DB を書き換えるか**: する（Image・ImportBatch・Person/Scene/Tag レコード追加）
- **Storage を書き換えるか**: する（thumbnail / preview / original をアップロード）
- **dry-run**: あり（`--dry-run`）
- **実行前に確認**:
  1. `extract:xlsx-images` が完了し manifest.json が存在すること
  2. workspace_id が正しいこと
  3. dry-run を先に実施して件数・パスを確認
- **失敗時の戻し方**: `cleanup:import-batch` に失敗 batch の ID を渡して削除する

---

### `npm run import:xlsx-batch` 🟡 WRITES DATA

**何をするか**: `tmp/xlsx-extract/` 配下の全 manifest を一括 import する。

```bash
# dry-run（件数・重複確認）
npm run import:xlsx-batch -- \
  --workspace-id <workspace_id> \
  --extract-root tmp/xlsx-extract \
  --dry-run

# 本実行（推奨オプション）
npm run import:xlsx-batch -- \
  --workspace-id <workspace_id> \
  --extract-root tmp/xlsx-extract \
  --person-from-sheet-name \
  --scene "XLSX Import" \
  --tags "xlsx-import" \
  --yes

# skip-existing（デフォルト: 既に import 済みの manifest はスキップ）
# 再 import したい場合は --no-skip-existing
```

- **DB を書き換えるか**: する（Image・ImportBatch・Person/Scene/Tag レコード追加）
- **Storage を書き換えるか**: する（thumbnail / preview / original をアップロード）
- **dry-run**: あり（`--dry-run`）
- **実行前に確認**:
  1. `extract:xlsx-batch` が完了していること
  2. workspace_id が正しいこと
  3. dry-run で件数を確認してから本実行
  4. `--person-from-sheet-name` / `--scene` / `--tags` の指定が意図通りであること
- **失敗時の戻し方**: 失敗した ImportBatch を `cleanup:import-batch` で削除して再実行。`repair:import-duplicates` で重複エラーを整理してから再実行することもある

---

## メンテナンス

### `npm run repair:import-duplicates` 🟠 REPAIRS DATA

**何をするか**: ImportBatch の error_log 内にある `Unique constraint failed` エラー行を `duplicate skip` として再分類する。

```bash
# dry-run（変更対象の確認のみ）
npm run repair:import-duplicates -- \
  --workspace-id <workspace_id> \
  --extract-root tmp/xlsx-extract \
  --dry-run

# 本実行
npm run repair:import-duplicates -- \
  --workspace-id <workspace_id> \
  --extract-root tmp/xlsx-extract
```

- **DB を書き換えるか**: する（ImportBatch の error_log を上書き）
- **Storage を書き換えるか**: しない
- **dry-run**: あり（`--dry-run`）
- **実行前に確認**:
  - 対象が本当に「別 batch から同一ファイルを再 import した重複」であること
  - dry-run で変更対象の batch ID・件数を確認してから本実行
- **失敗時の戻し方**: error_log の上書きのみのため、元の error_log の内容が失われる。Prisma Studio で手動確認してから実施すること

---

### `npm run cleanup:import-batch` 🔴 DELETES DATA

**何をするか**: 指定した ImportBatch とその関連 Image レコード・Storage ファイルを**完全に削除**する。

```bash
# dry-run（削除対象の確認のみ — 必ず先に実行）
npm run cleanup:import-batch -- \
  --import-batch-id <import_batch_id> \
  --dry-run

# 本実行（確認プロンプトあり）
npm run cleanup:import-batch -- \
  --import-batch-id <import_batch_id>

# 確認スキップ（自動化用）
npm run cleanup:import-batch -- \
  --import-batch-id <import_batch_id> \
  --yes
```

- **DB を書き換えるか**: する（Image レコード削除、ImportBatch 削除）
- **Storage を書き換えるか**: する（thumbnail / preview / original ファイルを Storage から削除）
- **dry-run**: あり（`--dry-run`）— **必ず dry-run を先に実行すること**
- **実行前に確認**:
  1. import_batch_id が正しいこと（Prisma Studio の `import_batches` テーブルで確認）
  2. dry-run で削除対象の Image 件数・Storage パスを確認
  3. Quick Add 画像（importBatchId なし）は対象外であることを把握
- **失敗時の戻し方**: **元に戻せない**。削除前に必要なら XLSX 原本から再 import する

---

### `npm run audit:storage-assets` 🟢 SAFE / 🔴 DELETES DATA

**何をするか**: Storage bucket と DB の image_path を突き合わせ、孤立ファイル（DB にないファイル）と欠損ファイル（DB にあるが Storage にないファイル）を検出する。`--cleanup-orphans` を付けると孤立ファイルを削除する。

```bash
# 🟢 SAFE: 確認のみ（デフォルト dry-run）
npm run audit:storage-assets -- \
  --workspace-id <workspace_id>

# 🔴 DELETES DATA: 孤立ファイルを削除（確認プロンプトあり）
npm run audit:storage-assets -- \
  --workspace-id <workspace_id> \
  --cleanup-orphans

# 🔴 DELETES DATA: 確認スキップ
npm run audit:storage-assets -- \
  --workspace-id <workspace_id> \
  --cleanup-orphans \
  --yes
```

- **DB を書き換えるか**: しない
- **Storage を書き換えるか**: `--cleanup-orphans` 指定時のみ（孤立ファイルを削除）
- **dry-run**: オプションなし = デフォルト dry-run。`--cleanup-orphans` で初めて削除が走る
- **実行前に確認**:
  1. workspace_id が正しいこと
  2. `--cleanup-orphans` を付ける前に必ずオプションなしで孤立ファイル一覧を確認
  3. 孤立ファイルが本当に不要なものかを確認（import 途中で中断した場合は正常な孤立の可能性がある）
- **失敗時の戻し方**: **孤立ファイルの削除は元に戻せない**。XLSX 原本があれば再 import で復元できる場合がある

---

## workspace_id の確認方法

1. Prisma Studio (`npm run db:studio`) → `workspaces` テーブル
2. `/dev/api-check` → **A テスト** (POST /api/scenes) を実行 → レスポンスの workspace 情報

---

## `.env.migrate` 設定例

```
DIRECT_URL=postgresql://postgres.<project-ref>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres
```

Transaction Pooler（port 6543）ではなく Session Mode（port 5432）を使うこと。
DDL（CREATE TABLE 等）は Transaction Pooler では動作しない。
