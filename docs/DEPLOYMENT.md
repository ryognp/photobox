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

> Preview デプロイも使う場合は、Vercel が発行した実際の Preview URL を Redirect URLs に追加する。
> Preview URL は project 名だけでなく branch 名・team slug を含む形式になるため、ワイルドカードパターン `https://<project>-*.vercel.app/**` では一致しないことがある。
>
> 例: `https://photobox-git-main-ikeuchi-4554s-projects.vercel.app/**`
>
> Vercel Dashboard → **Deployments** で実際に発行された URL を確認し、その URL（`/**` 付き）を Supabase Redirect URLs に追加すること。

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

## 7. Environment Inventory（環境変数棚卸し）

Vercel Dashboard → Project Settings → Environment Variables で、
Production / Preview / Development の各 scope を切り替えて以下の設定状況を確認する。

| 変数名 | Production | Preview | Development | 備考 |
|---|---|---|---|---|
| `DATABASE_URL` | 設定済み | 設定済み | ローカル `.env.local` | Transaction Pooler (port 6543) |
| `DIRECT_URL` | 設定済み | 設定済み | ローカル `.env.local` | Session Pooler (port 5432)、migration 用 |
| `NEXT_PUBLIC_SUPABASE_URL` | 設定済み | 設定済み | 設定済み | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 設定済み | 設定済み | 設定済み | anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | **設定済み** | **設定済み** | ローカル `.env.local` | **private bucket に必須** |
| `NEXT_PUBLIC_SITE_URL` | 本番 URL | Preview URL または本番 URL | `http://localhost:3007` | auth callback 用 |
| `ENABLE_DEV_API_CHECK` | `false` | `false` または `true` | `true` | Production は必ず `false` |

### NG パターン（要注意）

- Production / Preview のどちらかに `SUPABASE_SERVICE_ROLE_KEY` が抜けている
- `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` が存在する（クライアント露出）
- `ENABLE_DEV_API_CHECK=true` が Production に残っている
- `NEXT_PUBLIC_SITE_URL` が古い Preview URL のまま

### 確認手順

1. Vercel Dashboard → Project → Settings → Environment Variables を開く
2. Environment filter を **Production** に設定し、上記7変数がすべて存在するか確認
3. **Preview** に切り替えて同様に確認（特に `SUPABASE_SERVICE_ROLE_KEY` が抜けていないか）
4. env 変更・追加後は必ず **Redeploy** する

---

## 8. Preview Deployment の整理

### 整理の目的

- 古い Preview URL が Supabase Redirect URLs に残り続けると、削除された URL がいつまでも登録される
- Vercel 上に不要なデプロイが大量に残ることを防ぐ

### 手順

1. Vercel Dashboard → Project → **Deployments** を開く
2. **Production** alias（`[project].vercel.app`）が付いているデプロイは削除しない
3. `main` ブランチの最新 Production デプロイは残す
4. 現在使用中の Preview URL があれば残す
5. それ以外の古い Preview デプロイ（debug 用・作業中のもの）は削除候補

### Supabase Redirect URLs の整理

1. Supabase Dashboard → Authentication → URL Configuration を開く
2. 現在 Vercel に存在しない古い Preview URL が Redirect URLs に登録されていれば削除する
3. ワイルドカード（`https://<project>-*.vercel.app/**`）を使っている場合は残してよい

### Preview Deployment Cleanup チェックリスト

- [ ] 最新 Production Deployment を確認（削除しない）
- [ ] 現在使用中の Preview URL を確認
- [ ] 不要な debug 用 Preview デプロイを削除した
- [ ] Supabase Redirect URLs に不要な Preview URL が残っていない
- [ ] Production URL（`/login` `/gallery`）の動作確認済み

---

## 関連ドキュメント

| ファイル | 内容 |
|---|---|
| [OPERATIONS.md](OPERATIONS.md) | ローカル開発・DB 操作・運用手順 |
| [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) | リリース前チェックリスト（ローカル） |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | エラー対処一覧 |
| [SECURITY.md](SECURITY.md) | Secrets 管理・漏洩対応手順 |
| [BACKUP.md](BACKUP.md) | DB / Storage バックアップ・復旧方針 |
