# Photobox ユーザー操作マニュアル

対象読者: Photobox を日常的に使うユーザー（開発者以外でも読めるよう記述）

関連ドキュメント:
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — エラー・症状別対応表
- [XLSX_IMPORT_RUNBOOK.md](XLSX_IMPORT_RUNBOOK.md) — XLSX インポート詳細手順
- [SCRIPTS.md](SCRIPTS.md) — 全 CLI スクリプト詳細（危険度分類付き）
- [FINAL_QA.md](FINAL_QA.md) — 最終 QA チェックリスト

---

## 1. Photobox でできること

| 機能 | 説明 |
|---|---|
| **Quick Add** | ブラウザから画像をアップロードし、プロンプト・シーン・タグ・人物を付与して保存 |
| **Gallery** | 確定済み画像を一覧・検索・フィルタ。DetailPanel でプロンプト履歴を確認 |
| **Masters** | Person / Scene / Tag のマスタ管理・編集 |
| **Prompt Versions** | 同一画像の別プロンプト履歴を Gallery DetailPanel で確認 |
| **XLSX Import（CLI）** | ローカル PC 上の XLSX ファイルから画像をバッチインポート |
| **Storage Audit** | Storage の孤立ファイル検出・削除 |
| **Dev API Check** | API 動作確認（開発者向け） |

---

## 2. 起動方法

### ターミナルで起動する

```bash
cd "/Volumes/Extreme SSD/photobox/app"
npm run dev
```

起動後、ブラウザで以下を開く：

```
http://localhost:3007
```

### トラブル: localhost:3007 が開けない（connection refused）

開発サーバーが起動していない。ターミナルで `npm run dev` を実行する。

### トラブル: port 3007 already in use (EADDRINUSE)

```bash
lsof -ti :3007 | xargs kill -9
npm run dev
```

---

## 3. ログイン

### 初回: アカウント作成

```
http://localhost:3007/signup
```

メールアドレスとパスワードを入力してアカウント作成。

### 2回目以降: ログイン

```
http://localhost:3007/login
```

### ログイン後の主要ページ

| ページ | URL |
|---|---|
| Quick Add | `/quick-add` |
| Gallery | `/gallery` |
| Masters | `/masters` |
| Import | `/import` |
| Dev API Check | `/dev/api-check` |

### セッションが切れた場合

保護ページにアクセスすると自動的に `/login` にリダイレクトされる。ログインし直せばそのまま使える。

---

## 4. Quick Add の使い方

### 画像をアップロードする

1. `http://localhost:3007/quick-add` を開く
2. 画像ファイルをドラッグ&ドロップ（または「ファイルを選択」）
3. 複数ファイルを一度にドロップできる

### プロンプト・メタデータを設定する

アップロード後、各画像カードに以下を入力できる：

| 項目 | 説明 |
|---|---|
| **Prompt** | 英語プロンプト（必須）。AI 生成時に使ったプロンプトを貼る |
| **Notes** | 日本語メモ（任意）。意図や補足などを自由記述 |
| **Scene** | シーン分類（例: XLSX Import, Portrait など） |
| **Tags** | タグ（複数設定可） |
| **Persons** | 人物（例: 凛(Rin)） |
| **Rating** | 評価（1〜5） |

### 全画像に同一プロンプトを適用する

「全画像に適用」ボタンで入力済みプロンプトを他の画像にコピーできる。

### 入力済みにする

プロンプト入力後、「入力済みにする」をチェックする。確定前プレビューに進むには全画像が「入力済み」である必要がある。

### 確定前プレビューへ進む

「プレビューへ進む」ボタンをクリック → `/quick-add/commit` に移動。

### 確定保存する

`/quick-add/commit` で内容を確認し「確定」をクリック。

- 重複チェック（同一ファイルが既にある場合は警告が表示される）
- 確定後は Gallery に反映される

### よくあるエラー

| エラー | 原因 | 対応 |
|---|---|---|
| 画像サイズ超過 | ファイルサイズが大きすぎる | リサイズして再アップロード |
| 非対応形式 | HEIC 等の非対応形式 | JPEG / PNG / WebP に変換する |
| Storage error | Supabase 接続エラー | `.env.local` の `SUPABASE_SERVICE_ROLE_KEY` を確認 |
| prompt 未入力 | Prompt が空のまま進もうとした | 全画像に Prompt を入力してから進む |
| duplicate warning | 同一ファイルが既に Gallery に存在 | 警告を確認して重複をスキップするか確定する |

---

## 5. Gallery の使い方

### Gallery を開く

```
http://localhost:3007/gallery
```

### 画像一覧

- 初期表示は 48件程度
- ページ下部の「もっと読み込む」で追加読み込み
- サムネイルをクリックすると右側に **DetailPanel** が開く

> **注意**: スマートフォンや狭い画面（768px 未満）では DetailPanel が非表示になります。PC / タブレットでご使用ください。

### DetailPanel の見方

| 項目 | 場所 | 内容 |
|---|---|---|
| 英語 Prompt | 「プロンプト」欄 | AI 生成時のプロンプト原文 |
| Notes（日本語メモ） | 「notes」欄 | Quick Add / Import 時に入力したメモ |
| sourceSheetName | メタデータ欄 | XLSX のシート名（XLSX Import 由来の画像） |
| sourceRow | メタデータ欄 | XLSX の行番号（XLSX Import 由来の画像） |
| importBatchId | メタデータ欄 | どの ImportBatch で取り込まれたか |

### プロンプト・Notes のコピー

DetailPanel 内の「コピー」ボタンをクリックするとクリップボードにコピーされる。

### Prompt Versions（履歴）を見る

画像カードに「履歴 N」バッジがある場合、DetailPanel 内の「プロンプト履歴」セクションに過去のプロンプトが表示される。

- 「全文表示 ▼」で展開
- 「閉じる ▲」で折りたたみ
- 各バージョンの「コピー」でクリップボードにコピー

### フィルタ・検索

| 機能 | 操作 |
|---|---|
| Person フィルタ | 左サイドバーの「Person」から選択 |
| Scene フィルタ | 左サイドバーの「Scene」から選択 |
| Tag フィルタ | 左サイドバーの「Tag」から選択 |
| Favorite フィルタ | 左サイドバーの「Favorite」をチェック |
| テキスト検索 | 検索バーに入力（prompt / originalName / notes / sourceSheetName を横断検索） |
| フィルタ解除 | 各フィルタの「×」またはフィルタなしを選択 |

> **注意**: フィルタを変更しても URL バーは更新されません（後続フェーズで改善予定）。ブラウザの「戻る」でフィルタがリセットされる場合があります。

---

## 6. Masters の使い方

### Masters を開く

```
http://localhost:3007/masters
```

### タブ構成

- **Persons**: 人物マスタ（例: 凛(Rin)）
- **Scenes**: シーンマスタ（例: XLSX Import）
- **Tags**: タグマスタ（例: xlsx-import）

### imageCount の意味

各マスタ名の横に表示される数値は、そのマスタが付与されている画像の枚数。

### 新規マスタを作成する

タブ内の「＋ 追加」ボタンから名前を入力して作成。

### 名前を編集する

マスタ名の横の「編集」ボタンをクリックしてインライン編集。

### Gallery で絞り込む

「Gallery で絞り込む」リンクをクリックすると、そのマスタで絞り込まれた Gallery が開く。

### `[TEST]` マスタについて

`[TEST] API Check Person` 等、テスト由来のマスタが表示される場合がある。現時点では削除機能がないためそのまま残っている。実運用上の支障はない。

### まだできないこと

- マスタの削除（後続フェーズ予定）
- マスタの統合（後続フェーズ予定）

---

## 7. Import 画面の使い方

```
http://localhost:3007/import
```

### 現在の状態

- XLSX ファイルをドロップすると **parse 結果（シート名・列情報）** が表示される
- **実際の画像取込は CLI（ターミナル）で実行する**

### まだできないこと

- Web UI から XLSX 画像を直接インポート（後続フェーズ）
- Google Drive 共有リンクからの取込（MVP 非対応）
- image_url からの画像取込（後続フェーズ）

> XLSX を CSV に変換すると画像データが失われます。必ず XLSX 形式のままローカル Import CLI を使用してください。

---

## 8. XLSX ローカル Import の使い方

### XLSX を置く場所

```
/Volumes/Extreme SSD/photobox/xlsx/
```

### 手順概要

```
1. extract dry-run（内容確認）
2. extract 本実行（ローカルに画像展開）
3. import dry-run（件数・重複確認）
4. import 本実行（DB + Storage に取込）
5. audit（孤立ファイル確認）
```

### workspace_id の確認

Prisma Studio または `/dev/api-check` A テストで確認する。

```bash
cd "/Volumes/Extreme SSD/photobox/app"
npm run db:studio
# → http://localhost:5555 → workspaces テーブル
```

### Step 1: extract dry-run

```bash
cd "/Volumes/Extreme SSD/photobox/app"
npm run extract:xlsx-batch -- \
  --xlsx-dir "/Volumes/Extreme SSD/photobox/xlsx" \
  --dry-run
```

### Step 2: extract 本実行

```bash
npm run extract:xlsx-batch -- \
  --xlsx-dir "/Volumes/Extreme SSD/photobox/xlsx" \
  --out-root tmp/xlsx-extract
```

### Step 3: import dry-run

```bash
npm run import:xlsx-batch -- \
  --workspace-id <workspace_id> \
  --extract-root tmp/xlsx-extract \
  --dry-run
```

### Step 4: import 本実行

```bash
npm run import:xlsx-batch -- \
  --workspace-id <workspace_id> \
  --extract-root tmp/xlsx-extract \
  --person-from-sheet-name \
  --scene "XLSX Import" \
  --tags "xlsx-import" \
  --yes
```

### Step 5: Storage audit

```bash
npm run audit:storage-assets -- \
  --workspace-id <workspace_id>
```

詳細は [XLSX_IMPORT_RUNBOOK.md](XLSX_IMPORT_RUNBOOK.md) を参照。

---

## 9. /dev/api-check の使い方

```
http://localhost:3007/dev/api-check
```

開発環境（localhost）でのみ表示される。本番環境では表示されない。

### テスト項目の概要

| テスト範囲 | テスト ID |
|---|---|
| マスタ API（Person / Scene / Tag CRUD） | A〜J |
| Upload Session | K〜R |
| Upload Item（画像アップロード） | S〜Y |
| Prompt / Metadata | Z〜AH |
| CommitPreview | AI〜AQ |
| Gallery API | AR〜AU |
| Cleanup | AV〜AX |
| Import parse | AY〜BA |
| Gallery Detail / Filter / Search | BI〜BO |
| Prompt Versions | BP〜BR |
| Masters 管理（imageCount / PATCH） | BS〜BY |

### 毎回すべて実行する必要はない

確認したい範囲だけ実行すればよい。大きな変更後や Import 後は BS〜BY・BI〜BO・BP〜BR を確認することを推奨。

### 失敗した場合

- テスト名と HTTP ステータス・エラーメッセージを確認する
- 500 エラー → dev server のコンソール（ターミナル）でスタックトレースを確認
- 401 エラー → 未ログイン状態。ブラウザで `/login` からログインし直す

---

## 10. よくあるトラブル

| 症状 | 対応 |
|---|---|
| localhost:3007 が開けない | ターミナルで `npm run dev` を実行する |
| EADDRINUSE: port 3007 | `lsof -ti :3007 \| xargs kill -9` してから `npm run dev` |
| Invalid Compact JWS | Supabase Dashboard で service_role key を Regenerate する |
| Supabase Storage signed URL error | `.env.local` の `SUPABASE_SERVICE_ROLE_KEY` と bucket 名 `photobox-private` を確認 |
| Gallery が重い | 628件の場合は初回ロードに数秒かかる場合がある。正常動作 |
| Gallery に画像が出ない | ログインしているか確認。`/api/images` の応答を確認 |
| ImportBatch が PROCESSING で止まる | [OPERATIONS.md](OPERATIONS.md) の「PROCESSING で止まっている batch の対処」を参照 |
| Storage orphan が出る | `npm run audit:storage-assets -- --workspace-id <id>` で確認・削除 |
| macOS `._*` ファイル | xlsx フォルダに隠しファイルが生成されることがある。extract スクリプトは自動スキップする |
| XLSX を CSV に変換したら画像が消えた | XLSX 形式のまま使用すること。CSV では画像データが失われる |

---

## 11. まだできないこと

以下の機能は後続フェーズで実装予定です。

- 画像削除
- 画像編集（メタデータ変更）
- Prompt の編集 UI
- Prompt Versions の手動作成 UI
- シーン変換
- Import UI からの本格 XLSX 取込
- image_url からの画像取込
- マスタ削除 / 統合
- モバイル用 DetailPanel drawer
- Gallery フィルタ変更時の URL 同期
