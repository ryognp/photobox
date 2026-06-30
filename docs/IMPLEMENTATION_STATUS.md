# 実装状況サマリー

最終更新: 2026-06-30

---

## 実装済み

### Auth

- [x] Supabase Auth (email/password)
- [x] signup / login / logout
- [x] session cookie 管理
- [x] 未ログイン時の /login リダイレクト（middleware）

### Workspace

- [x] workspace 自動作成（signup 時）
- [x] workspace_members テーブル
- [x] API Route での workspace 権限チェック（body の workspaceId は信用しない）

### Quick Add（Upload Session / Upload Item）

- [x] Upload Session CRUD（作成・取得・更新・破棄）
- [x] Upload Item CRUD（画像アップロード・メタデータ設定）
- [x] クライアント側 SHA-256 計算 + thumbnail/preview WebP 生成
- [x] Server 側 thumbnail/preview 存在確認
- [x] 重複チェック（fileHash による）
- [x] Prompt / scene / tags / persons の設定
- [x] CommitPreview（確定前プレビュー）
- [x] Commit（画像の確定保存）
- [x] prompt_versions への退避（既存 prompt がある場合）

### Gallery

- [x] 画像一覧（cursor-based pagination, limit 48）
- [x] Person / Scene / Tag / Favorite フィルタ
- [x] OR 検索（searchText / originalName / notes / prompt）
- [x] 並び順（新しい順 / 古い順）
- [x] URL params 初期フィルタ（`?personId=` / `?sceneId=` / `?tagId=`）
- [x] 画像カード（thumbnail, lazy loading, 履歴バッジ）
- [x] DetailPanel（signed URL プレビュー, メタデータ表示）
- [x] Prompt Versions 表示（履歴バッジ, 展開/折りたたみ, コピー）
- [x] 画像エラー時のフォールバック表示
- [x] FilterSidebar（モバイル非表示 sm:flex）

### Masters

- [x] GET /api/persons（imageCount 付き）
- [x] GET /api/scenes（imageCount 付き）
- [x] GET /api/tags（imageCount 付き）
- [x] POST /api/persons / scenes / tags（upsert）
- [x] PATCH /api/persons/:id（name / notes / defaultPromptHint）
- [x] PATCH /api/scenes/:id（name / description）
- [x] PATCH /api/tags/:id（name）
- [x] 同名 409 CONFLICT チェック
- [x] /masters ページ（Person / Scene / Tag タブ）
- [x] インライン編集 UI
- [x] imageCount 表示
- [x] 「Gallery で絞り込む」リンク

### Cleanup

- [x] GET/POST /api/uploads/cleanup（dry-run / 実行）
- [x] 3日以上前の未コミット session を削除

### XLSX ローカル Import CLI

- [x] extract:xlsx-images（単一 XLSX 抽出）
- [x] extract:xlsx-batch（一括抽出）
- [x] import:xlsx-extract（単一 manifest import）
- [x] import:xlsx-run（XLSX 直接 import）
- [x] import:xlsx-batch（一括 import）
- [x] cleanup:import-batch（batch 削除）
- [x] repair:import-duplicates（重複エラー修正）
- [x] audit:storage-assets（孤立ファイル検出・削除）
- [x] ImportBatch テーブル管理
- [x] --dry-run / --yes / --skip-existing オプション

### Storage

- [x] private bucket `photobox-private`
- [x] signed URL 発行（thumbnail 900s / preview 600s / original 300s）
- [x] service_role key はサーバー側のみ使用

### Dev API Check

- [x] /dev/api-check（development only）
- [x] A〜AX: マスタ・Upload・Commit・Gallery・Cleanup・Import テスト
- [x] BI〜BO: Gallery Detail / Filter / Search テスト
- [x] BP〜BR: Prompt Versions テスト
- [x] BS〜BY: Masters 管理 テスト（imageCount / PATCH / Gallery link）
- [x] 固定名テストマスタで idempotent（増殖しない）

### ナビゲーション（Day 9-A）

- [x] 全主要ページ間の相互リンク（Gallery / Quick Add / Masters / Import）
- [x] /dev/api-check にナビリンク（Gallery / Quick Add / Masters / Import）
- [x] /gallery に Quick Add / Masters / Import 導線追加
- [x] /quick-add に Gallery / Masters / Import 導線追加
- [x] /masters に Gallery / Quick Add / Import 導線追加
- [x] /import に Gallery / Quick Add / Masters 導線追加

### レスポンシブ（Day 9-A）

- [x] Gallery: FilterSidebar は sm:（640px）以上で表示
- [x] Gallery: DetailPanel は md:（768px）以上で表示（スマホは非表示 — PC/タブレット優先 MVP）
- [x] Gallery: SearchBar はモバイルで幅縮小
- [x] Masters: card grid は sm:grid-cols-2 lg:grid-cols-3
- [x] /dev/api-check の pre は overflow-x: auto 対応

### ドキュメント整備（Day 9-B）

- [x] README.md 更新（概要・スタック・セットアップ・よくあるトラブル）
- [x] docs/OPERATIONS.md（運用手順・DB 操作・トラブル対応）
- [x] docs/SCRIPTS.md（全 npm scripts 詳細）
- [x] docs/XLSX_IMPORT_RUNBOOK.md（XLSX バッチインポート手順）
- [x] docs/BACKUP.md（バックアップ方針）
- [x] docs/RELEASE_CHECKLIST.md（リリース前チェックリスト）
- [x] docs/IMPLEMENTATION_STATUS.md（本ファイル）
- [x] .gitignore 再確認（.env.local / tmp/ / ._* 等 完備確認済み）

---

## 未実装（後続フェーズ）

### 画像操作

- [ ] 画像削除（soft delete）
- [ ] 画像編集（メタデータ変更）
- [ ] 一括操作（複数選択・一括タグ付け等）

### Prompt

- [ ] prompt 編集 UI
- [ ] prompt_versions 作成 UI（手動バージョン追記）
- [ ] シーン変換 UI（SCENE_TRANSFORM）

### Masters

- [ ] マスタ削除
- [ ] マスタ統合（2件を1件にマージ）

### Import

- [ ] Import UI 統合（XLSX import を Web UI から実行）
- [ ] image_url Import 本実装（URL から画像を取得して import）

### 運用・自動化

- [ ] cleanup cron（定期的な未コミット session 削除）
- [ ] Storage audit cron
- [ ] バックアップ自動化

### UX

- [ ] モバイル用 Detail drawer（現在は md 未満で DetailPanel 非表示）
- [ ] Gallery URL params の双方向同期（フィルタ変更時に URL を更新）
- [ ] Toast 通知（本格実装）
- [ ] エラー監視（Sentry 等）

### インフラ

- [ ] 本番環境デプロイ（Vercel 等）
- [ ] Google Sheets API 連携

---

## 現在のローカル環境の状態（2026-06-30 時点）

> この記録は **2026-06-30 時点のローカル開発環境のスナップショット** です。
> Import 追加・cleanup・Quick Add 追加などで変動するため、固定仕様値ではありません。
> 将来の環境・再構築後では値が変わります。

| 項目 | 値 |
|---|---|
| images（ACTIVE） | 628件 |
| prompts | 628件 |
| prompt_versions | 2件 |
| importBatchId あり画像 | 627件（XLSX import 由来） |
| importBatchId なし画像 | 1件（Quick Add 由来） |
| image_tags: xlsx-import | 627件 |
| image_persons: 凛(Rin) | 627件 |
| import_batches（DONE） | 9件 |
| import_batches error_count 合計 | 0 |
| Storage audit Missing | 0件 |
| Storage audit Orphan | 0件 |

### ファイルパス

| 対象 | パス |
|---|---|
| XLSX 原本フォルダ | `/Volumes/Extreme SSD/photobox/xlsx` |
| extract 出力先 | `app/tmp/xlsx-extract/` |
| Gallery 確認件数 | 628件 |

### 補足

- `[TEST] person-...-updated` という名前の Person が残っているが、現時点では削除機能を作らない方針のためそのまま
- Quick Add 由来の画像 1件は importBatchId なし（Gallery で確認可能）
- prompt_versions 2件は Quick Add でのプロンプト編集時に退避されたもの

---

## ドキュメント一覧

| ファイル | 内容 |
|---|---|
| [USER_MANUAL.md](USER_MANUAL.md) | ユーザー操作マニュアル |
| [FINAL_QA.md](FINAL_QA.md) | 最終 QA チェックリスト |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | トラブルシューティング一覧 |
| [OPERATIONS.md](OPERATIONS.md) | 運用手順 |
| [SCRIPTS.md](SCRIPTS.md) | npm scripts 詳細（危険度分類付き） |
| [XLSX_IMPORT_RUNBOOK.md](XLSX_IMPORT_RUNBOOK.md) | XLSX インポート手順 |
| [BACKUP.md](BACKUP.md) | バックアップ方針 |
| [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) | リリース前チェックリスト |

---

## 推奨次フェーズ

### Day 9-C: ユーザー操作マニュアル作成 / 本番運用前最終 QA（次のステップ）

1. 全ページの操作マニュアル（スクリーンショット不要の文書版）
2. /dev/api-check 全テストの最終確認
3. セキュリティ最終確認

### Day 10: 画像削除機能 / 画像編集機能

1. PATCH /api/images/:id（メタデータ編集）
2. DELETE /api/images/:id（soft delete）
3. Gallery での編集 UI

### Day 11: Import UI 統合 / prompt 編集

1. Web UI から XLSX upload → parse → import
2. Gallery DetailPanel から prompt 編集
