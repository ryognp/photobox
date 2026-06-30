# バックアップ方針

## ⚠ セキュリティ前提

このシステムは**人物写真**を扱う。バックアップデータの取り扱いには特に注意すること。

- Storage は **private** のまま維持する（public bucket にしない）
- バックアップデータを不特定多数が閲覧できる場所に置かない
- `.env.local` はバックアップを共有しない
- `SUPABASE_SERVICE_ROLE_KEY` は絶対に共有しない

---

## DB バックアップ

### Supabase 自動バックアップ

Supabase は daily backup を自動で取得している（有料プランによって保持期間が異なる）。

確認場所: Supabase Dashboard → **Database → Backups**

- Free plan: 7日間保持
- Pro plan: 30日間保持

### 手動バックアップ（必要時）

Supabase Dashboard → **Database → Backups → Download** で任意時点の dump を取得できる。

または pg_dump を直接使用:

```bash
pg_dump \
  "postgresql://postgres.xxxx:<password>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres" \
  --no-owner \
  --no-acl \
  -f backup_$(date +%Y%m%d).sql
```

この dump ファイルは人物写真の **メタデータ**（パス・プロンプト等）を含むため安全に保管すること。

---

## Storage バックアップ

Supabase Storage の画像ファイルは `photobox-private` bucket に保存されている。

### 現状

Supabase Storage の自動バックアップは DB バックアップとは別管理。
Supabase Dashboard からの手動ダウンロードが可能だが、件数が多い場合は Storage API 経由のスクリプトが必要。

### 推奨方針（MVP フェーズ）

- **XLSX 原本を保持していれば再 import が可能**（以下参照）
- 大規模障害時は XLSX から再構築する
- 定期的に `audit:storage-assets` で Storage の整合性を確認する

---

## XLSX 原本の保管場所

```
/Volumes/Extreme SSD/photobox/xlsx/
```

- これが画像データの **一次ソース**
- このディレクトリを失うと再 import が不可能
- 定期的に外部ストレージ（外付け HDD 等）にバックアップする

---

## tmp/xlsx-extract の扱い

```
/Volumes/Extreme SSD/photobox/app/tmp/xlsx-extract/
```

- XLSX から展開した中間データ（画像 + manifest.json）
- git 管理外（`.gitignore` に `/tmp/` を記載）
- **削除しても XLSX 原本から再 extract できる**
- ただし再 import では重複チェックが走るため既存 import は保護される

---

## import 済み manifest の保管方針

各 XLSX の `tmp/xlsx-extract/<name>/manifest.json` は以下を含む:

- 抽出した画像のファイルパス・sha256
- XLSX のシート名・行番号

これは DB の `import_batches` / `images` テーブルに対応しており、障害時の突き合わせに使える。

**方針**: `tmp/xlsx-extract/` を定期的に外部ストレージにバックアップする。

---

## 復旧時に必要なもの

| 復旧シナリオ | 必要なもの |
|---|---|
| DB 障害のみ | Supabase backup dump |
| Storage 障害のみ | XLSX 原本 + manifest + DB のメタデータ |
| DB + Storage 両方 | XLSX 原本 + Supabase dump |
| 全損 | XLSX 原本（ゼロから再構築） |

### 全損からの復旧手順（概要）

1. 新 Supabase プロジェクト作成、bucket `photobox-private` を private で作成
2. `.env.local` を新しい接続情報で更新
3. `npm run db:migrate:prod` で schema を適用
4. signup して workspace を作成
5. `extract:xlsx-batch` → `import:xlsx-batch` で再 import
6. `audit:storage-assets` で整合性確認

Quick Add 画像（XLSX 以外）は現時点では XLSX 以外のバックアップ手段がないため、**XLSX 由来のデータのみ復旧可能**。

---

## .env.local のバックアップ

- `.env.local` は git に含めない
- 値は Supabase Dashboard から再取得できる
- ローカルマシンの安全な場所（パスワードマネージャー等）に保存する
- **絶対に他者と共有しない**（service_role key が含まれる）

---

## 定期バックアップ推奨スケジュール

| 対象 | 頻度 |
|---|---|
| XLSX 原本（`/Volumes/Extreme SSD/photobox/xlsx/`） | 月1回以上 |
| tmp/xlsx-extract | import 完了後に外部 HDD へコピー |
| Supabase DB dump | 月1回（Supabase 自動バックアップがあれば手動は不要） |
| .env.local の値 | 変更時にパスワードマネージャーへ |
