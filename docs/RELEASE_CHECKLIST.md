# リリース前チェックリスト

実施日: ____/__/__
担当: ________

最終確認バージョン: Day 9-B（2026-06-30）

---

## 1. 静的チェック

```bash
cd /Volumes/Extreme\ SSD/photobox/app
```

- [ ] `npm run lint` — 0 errors
- [ ] `npm run build` — 成功（型エラーなし）
- [ ] `npm run db:validate` — schema valid

---

## 2. ページ確認

### /login

- [ ] ページが開ける
- [ ] メールアドレス・パスワードを入力してログインできる
- [ ] 未入力でのエラーが表示される

### /signup

- [ ] ページが開ける
- [ ] 新規アカウント作成できる
- [ ] 既存メールアドレスでのエラーが表示される

### /quick-add

- [ ] ログイン済みで表示される
- [ ] 未ログイン時に `/login` にリダイレクトされる
- [ ] 画像をドラッグ&ドロップでアップロードできる
- [ ] プロンプトを入力できる
- [ ] シーン・タグ・人物を設定できる
- [ ] Gallery / Masters / Import へのナビリンクがある

### /quick-add/commit

- [ ] CommitPreview が表示される
- [ ] 重複チェックが動く
- [ ] 確定保存ができる

### /gallery

- [ ] 画像一覧が表示される（628件以上）
- [ ] 初期表示は 48件程度
- [ ] 「もっと読み込む」で追加読み込みができる
- [ ] Person フィルタで絞り込める（凛(Rin)で確認）
- [ ] Scene フィルタで絞り込める（XLSX Importで確認）
- [ ] Tag フィルタで絞り込める（xlsx-importで確認）
- [ ] 検索（q）が動く
- [ ] 画像クリックで DetailPanel が開く
- [ ] DetailPanel にプロンプトが表示される
- [ ] 履歴バッジ（「履歴 N」）がある画像で prompt_versions が表示される
- [ ] signed URL で画像が表示される
- [ ] Quick Add / Masters / Import へのナビリンクがある
- [ ] URL パラメータ `?personId=` / `?sceneId=` / `?tagId=` で初期フィルタが動く

### /masters

- [ ] Persons / Scenes / Tags タブが表示される
- [ ] 凛(Rin) が表示され imageCount > 0
- [ ] XLSX Import シーンが表示され imageCount > 0
- [ ] xlsx-import タグが表示され imageCount > 0
- [ ] 名前の編集ができる（[TEST] API Check Person で確認）
- [ ] 「Gallery で絞り込む」リンクが動く
- [ ] 検索（絞り込み）が動く
- [ ] Gallery / Quick Add / Import へのナビリンクがある

### /import

- [ ] XLSX ファイルをドロップできる
- [ ] parse 結果（シート・列情報）が表示される
- [ ] Gallery / Quick Add / Masters へのナビリンクがある

### /dev/api-check

- [ ] development 環境でのみ表示される
- [ ] Gallery / Quick Add / Masters / Import へのナビリンクがある
- [ ] **Masters 管理 BS〜BY** テストがすべて PASS
- [ ] **Gallery Detail / Filter BI〜BO** テストがすべて PASS
- [ ] **Prompt Versions BP〜BR** テストが PASS
- [ ] **Cleanup AV〜AX** が動く（AX は dry-run のみ）

---

## 3. 大量データ確認（628件）

- [ ] Gallery 初期表示が 3秒以内に完了する
- [ ] 「もっと読み込む」が動く
- [ ] フィルタ切り替えが重くない
- [ ] DetailPanel が正常に開く

---

## 4. Prompt Versions 確認

- [ ] 「履歴 N」バッジがある画像が存在する
- [ ] DetailPanel に「プロンプト履歴」セクションが表示される
- [ ] 「全文表示 ▼」「閉じる ▲」が動く
- [ ] 「コピー」ボタンで「コピーしました ✓」が表示される

---

## 5. Storage / 孤立ファイル確認

```bash
npm run audit:storage-assets -- --workspace-id <workspace_id>
```

- [ ] orphan ファイルがない（または許容範囲内）
- [ ] missing ファイルがない

---

## 6. ImportBatch 確認

```sql
SELECT status, COUNT(*) FROM import_batches GROUP BY status;
```

- [ ] PROCESSING が 0件（または正常に走っている batch のみ）
- [ ] FAILED が 0件（または調査済み）

---

## 7. 環境変数確認

- [ ] `.env.local` に以下が設定されている
  - `DATABASE_URL`
  - `DIRECT_URL`
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
- [ ] `.env.local` は `.gitignore` に含まれている（`git status` で確認）

---

## 8. セキュリティ確認

- [ ] `SUPABASE_SERVICE_ROLE_KEY` がクライアントコードに含まれていない
  ```bash
  grep -r "service_role" /Volumes/Extreme\ SSD/photobox/app/src --include="*.tsx" --include="*.ts" | grep -v "server-only" | grep -v "SUPABASE_SERVICE_ROLE_KEY"
  ```
- [ ] `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` が存在しない
  ```bash
  grep -r "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY" /Volumes/Extreme\ SSD/photobox/app/
  ```
- [ ] Storage bucket `photobox-private` が private である（Supabase Dashboard で確認）
- [ ] signed URL 以外で画像を返す API がない
- [ ] `tmp/` が git に含まれていない（`.gitignore` 確認）

---

## 9. git 確認

- [ ] 意図しないファイルが含まれていない
  ```bash
  git status
  git diff --stat HEAD
  ```
- [ ] `.env.local` が含まれていない
- [ ] `tmp/xlsx-extract/` が含まれていない
- [ ] `src/generated/prisma/` が含まれていない（`.gitignore` 確認）

---

## 10. Vercel 本番確認

> ローカル確認完了後、本番 URL でも以下を確認する。

- [ ] Vercel 環境変数がすべて設定されている（[DEPLOYMENT.md](DEPLOYMENT.md) の表を参照）
  - `DATABASE_URL`
  - `DIRECT_URL`
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY` ← **private bucket signed URL に必須**
  - `NEXT_PUBLIC_SITE_URL`
- [ ] Supabase → Authentication → URL Configuration に本番ドメインが登録されている
- [ ] `/login` — ページが表示される
- [ ] ログイン成功後 `/gallery` にリダイレクトされる
- [ ] `/gallery` — 画像が表示される（500 エラーがない）
- [ ] `/quick-add` — 画像アップロードができる
- [ ] `/masters` — 一覧が表示される
- [ ] 診断 API が存在しないこと（すべて 404）
  ```bash
  curl -o /dev/null -s -w "%{http_code}" https://<domain>/api/images-debug
  # → 404
  curl -o /dev/null -s -w "%{http_code}" https://<domain>/api/runtime-db-connect-check
  # → 404
  curl -o /dev/null -s -w "%{http_code}" https://<domain>/api/runtime-db-check
  # → 404
  ```
- [ ] `ENABLE_DEV_API_CHECK=false` で `/dev/api-check` が Production で無効になっている

---

## メモ欄

```
実施日:
確認者:
問題点:
対応内容:
```
