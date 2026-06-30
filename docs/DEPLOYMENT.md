# Photobox — Vercel / Supabase デプロイ手順

最終更新: 2026-06-30

---

## 前提

- GitHub リポジトリ: https://github.com/ryognp/photobox
- Supabase プロジェクト作成済み
- Supabase Storage `photobox-private` バケット作成済み (non-public)
- Vercel アカウント作成済み

---

## 1. Supabase 設定

### 1-1. Site URL と Redirect URLs

Supabase Dashboard → **Authentication → URL Configuration**

| 設定項目 | 値 |
|---|---|
| Site URL | `https://<your-vercel-domain>.vercel.app` |
| Redirect URLs | `https://<your-vercel-domain>.vercel.app/**` |

> Preview デプロイも使う場合は `https://<project>-*.vercel.app/**` も追加する。

### 1-2. Storage bucket

- Dashboard → **Storage** → `photobox-private` が存在し **Private** (non-public) であること
- Public にしてはいけない（signed URL 経由でのみ画像を配信する）

### 1-3. Database migration

本番 DB への migration は `DIRECT_URL`（Session Mode, port 5432）が必要。

```bash
cd /Volumes/Extreme\ SSD/photobox/app
# .env.migrate に DIRECT_URL を設定してから実行
npm run db:migrate:prod
```

---

## 2. Vercel 環境変数

Vercel Dashboard → **Project Settings → Environment Variables** に以下を設定する。

すべて **Production / Preview / Development** の対象にする（または用途に応じて選択）。

| 変数名 | 取得場所 | 備考 |
|---|---|---|
| `DATABASE_URL` | Supabase → Settings → Database → **Transaction Pooler** URI | port 6543, `?pgbouncer=true` 付き |
| `DIRECT_URL` | Supabase → Settings → Database → **Session Mode** URI | port 5432, migration 用 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API → Project URL | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API → **anon public** | |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → **service_role** | ⚠️ 下記参照 |
| `NEXT_PUBLIC_SITE_URL` | `https://<your-vercel-domain>.vercel.app` | auth callback 用 |

### ⚠️ SUPABASE_SERVICE_ROLE_KEY は必須

**private bucket の signed URL 発行に `SUPABASE_SERVICE_ROLE_KEY` が必要。**
この変数が未設定の場合、`/gallery` で画像が表示されず 500 エラーになる。

- `NEXT_PUBLIC_` prefix を付けない（クライアントに絶対露出しない）
- Vercel のログや GitHub に貼らない
- 漏洩した場合は Supabase Dashboard で即 Regenerate する

### ENABLE_DEV_API_CHECK

| 環境 | 値 |
|---|---|
| Production | `false` または未設定 |
| Preview / Development | `true`（任意） |

---

## 3. Vercel デプロイ

### 初回デプロイ

1. Vercel Dashboard → **Add New Project** → GitHub リポジトリを接続
2. **Root Directory** を `app` に設定
3. 環境変数を上記 2 のとおり設定
4. **Deploy**

### Redeploy（env 変更後）

環境変数を変更・追加した場合は必ず **Redeploy** が必要（既存のビルドには反映されない）。

Vercel Dashboard → **Deployments** → 最新デプロイの `…` → **Redeploy**

---

## 4. デプロイ後の動作確認チェックリスト

Redeploy 完了後、本番 URL で以下を順に確認する。

### 4-1. 基本ページ

- [ ] `/login` — ページが表示される
- [ ] `/signup` — アカウント作成できる
- [ ] ログイン後 → `/gallery` にリダイレクトされる

### 4-2. /gallery

- [ ] 画像一覧が表示される（signed URL で画像が読み込まれる）
- [ ] 500 エラーが出ない（`SUPABASE_SERVICE_ROLE_KEY` が設定済みか確認）
- [ ] フィルタ（Person / Scene / Tag）が動く
- [ ] 検索が動く
- [ ] DetailPanel が開く

### 4-3. /quick-add

- [ ] 画像をアップロードできる
- [ ] `/quick-add/commit` で確定保存できる

### 4-4. /masters

- [ ] Person / Scene / Tag 一覧が表示される

### 4-5. セキュリティ確認

- [ ] `/api/images-debug` → 404 が返る（診断 API は削除済み）
- [ ] `/api/runtime-db-connect-check` → 404 が返る（診断 API は削除済み）
- [ ] `/api/runtime-db-check` → 404 が返る（診断 API は削除済み）
- [ ] `/dev/api-check` → Production では 404 または表示されない（`ENABLE_DEV_API_CHECK=false`）
- [ ] ブラウザ DevTools で `SUPABASE_SERVICE_ROLE_KEY` がレスポンスに含まれていない

---

## 5. よくある Vercel Runtime エラーと対処

| エラー | 原因 | 対処 |
|---|---|---|
| `/gallery` 500、`supabaseKey is required` | `SUPABASE_SERVICE_ROLE_KEY` 未設定 | Vercel env に追加 → Redeploy |
| `/gallery` 500、Prisma P1001 | `DATABASE_URL` 未設定または誤り | Vercel env を確認 → Redeploy |
| ログイン後に `/login` に戻る | Supabase Redirect URLs 未設定 | Supabase → Auth → URL Configuration を確認 |
| 画像が表示されない（signed URL エラー） | `SUPABASE_SERVICE_ROLE_KEY` 誤り / bucket 名違い | service_role key と bucket 名 `photobox-private` を確認 |
| Build 失敗 | 型エラー / lint エラー | ローカルで `npm run lint && npm run build` を確認 |

---

## 6. 診断 API（削除済み）

以下の診断用エンドポイントは調査完了後に削除済み。本番には存在しない。

- `/api/images-debug`
- `/api/runtime-db-connect-check`
- `/api/runtime-db-check`

将来また診断が必要になった場合は、環境変数でガードした一時的なエンドポイントを追加し、調査完了後に削除すること。

---

## 関連ドキュメント

| ファイル | 内容 |
|---|---|
| [OPERATIONS.md](OPERATIONS.md) | ローカル開発・DB 操作・運用手順 |
| [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) | リリース前チェックリスト（ローカル） |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | エラー対処一覧 |
