# Photobox — 本番デプロイ手順書

> **状態**: Production Hardening 完了 (Day 10 / 2026-06-30)  
> まだデプロイは実行していません。この手順書に従って順番に進めてください。

---

## 前提チェックリスト

デプロイ前に以下がすべて ✅ であることを確認してください:

- [ ] `npm run lint` 警告なし
- [ ] `npm run build` 成功
- [ ] `npm run db:validate` schema valid
- [ ] `npm run audit:storage-assets -- --workspace-id <id> --dry-run` Missing 0 / Orphan 0
- [ ] `.env.local` に実キーが含まれており、Git に含まれていないこと
- [ ] `.env.example` / `.env.migrate.example` がプレースホルダーのみであること

---

## 1. GitHub リポジトリ作成

### 1-1. ローカルで Git を初期化（まだなら）

```bash
cd /Volumes/Extreme\ SSD/photobox/app

git init
git add .
git commit -m "chore: initial production-ready commit"
```

### 1-2. Push 前の必須チェック

```bash
# 実キーがステージされていないか確認
git diff --cached | grep -E "eyJ|sb_secret_|postgresql://.*:[^@]+@" && echo "⚠️ 実キーが含まれています" || echo "✅ 実キーなし"

# 除外されているべきファイルがステージされていないか確認
git status | grep -E "\.env\.local|\.env\.migrate$|\.xlsx$"
```

**`.gitignore` チェックリスト（push 前）:**

| ファイル / パターン | 状態 |
|-------------------|------|
| `.env.local` | Git 管理外 ✅ |
| `.env.migrate` | Git 管理外 ✅ |
| `.env` | プレースホルダーのみ ✅ |
| `.env.example` | プレースホルダーのみ ✅ |
| `.env.migrate.example` | プレースホルダーのみ ✅ |
| `*.xlsx` / `*.xls` | Git 管理外 ✅ |
| `/tmp/xlsx-extract/` | Git 管理外 ✅ |
| `/src/generated/prisma/` | Git 管理外（ビルド時に生成）✅ |

### 1-3. GitHub に push

```bash
# GitHub で新規リポジトリを作成後:
git remote add origin https://github.com/<your-org>/photobox.git
git push -u origin main
```

---

## 2. Supabase 設定確認（デプロイ前）

### 2-1. Storage Bucket をプライベートに設定

Supabase Dashboard > Storage > Buckets > `photobox-images`

- **Public bucket**: **OFF**（プライベートであること）
- アクセスは signed URL 経由のみ
- アプリは `/api/images/[id]/signed-url` 経由で一時URLを発行している

> ⚠️ Public bucket のままだと Storage URL を知っている誰でも画像を閲覧できます。  
> 必ずプライベートに設定されていることを確認してください。

### 2-2. Auth — Site URL と Redirect URLs

Supabase Dashboard > Authentication > URL Configuration:

| 設定項目 | 値 |
|---------|---|
| **Site URL** | `https://your-app.vercel.app` |
| **Redirect URLs** | `https://your-app.vercel.app/**` |
| （Preview 用）| `https://*.vercel.app/**` |

> Site URL を設定しないとメール認証・OAuth のリダイレクトが失敗します。

### 2-3. RLS ポリシー確認

```bash
# RLS が有効になっているテーブルを確認
# docs/rls-policies.sql を参照
cat docs/rls-policies.sql
```

---

## 3. Vercel プロジェクト作成

1. https://vercel.com/new にアクセス
2. **Import Git Repository** で GitHub の `photobox` リポジトリを選択
3. **Root Directory** を **`app`** に設定

   > ⚠️ これを設定しないと Vercel がリポジトリ root を Next.js root と誤認します。

4. Framework Preset: **Next.js**（自動検出される）
5. Build Command: `npm run build`（デフォルトのまま）
6. Output Directory: `.next`（デフォルトのまま）
7. **Environment Variables** は次のセクションで設定するため、この画面ではまだ Deploy しない

---

## 4. Environment Variables 設定

Vercel Dashboard > Project > Settings > Environment Variables

### 必須変数

| 変数名 | 対象環境 | 値の取得元 |
|--------|---------|-----------|
| `DATABASE_URL` | Production, Preview | Supabase > Project Settings > Database > **Transaction Pooler** URI (port **6543**) |
| `DIRECT_URL` | Production, Preview | Supabase > Project Settings > Database > **Session Mode** URI (port **5432**) |
| `NEXT_PUBLIC_SUPABASE_URL` | All | Supabase > Project Settings > API > **Project URL** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | All | Supabase > Project Settings > API > **anon public** key |
| `SUPABASE_SERVICE_ROLE_KEY` | Production, Preview | Supabase > Project Settings > API > **service_role** key |
| `NEXT_PUBLIC_SITE_URL` | Production | `https://your-app.vercel.app`（デプロイ後の実URL）|
| `ENABLE_DEV_API_CHECK` | Production | `false`（または未設定）|

### 変数設定時の注意

```
⚠️ SUPABASE_SERVICE_ROLE_KEY
  - 変数名に NEXT_PUBLIC_ を付けない → クライアントバンドル露出を防ぐ
  - Vercel の "Sensitive" フラグを有効にする（ログに表示されない）
  - 値は Supabase の legacy service_role JWT（eyJ... で始まる長い文字列）

⚠️ DATABASE_URL
  - ?pgbouncer=true パラメータを含む Transaction Pooler URL を使用
  - pgbouncer=true がないと Prisma の接続プーリングが正しく動作しない

⚠️ NEXT_PUBLIC_SITE_URL
  - デプロイ後の実 URL に更新すること
  - Supabase の Site URL とも一致させること
```

---

## 5. デプロイ実行

```bash
# 事前チェック（再確認）
cd /Volumes/Extreme\ SSD/photobox/app
npm run lint        # 警告なし
npm run build       # ビルド成功
npm run db:validate # schema valid

# Vercel CLI でデプロイ
npx vercel --prod
# または GitHub push → Vercel が自動デプロイ
```

---

## 6. 本番確認項目

デプロイ後にブラウザで以下を確認してください:

### 認証
- [ ] `https://your-app.vercel.app/login` → ログイン画面が表示される
- [ ] メール / パスワードでログイン → `/gallery` へリダイレクト
- [ ] 未認証でアクセス → `/login` へリダイレクト

### Gallery
- [ ] 画像一覧が表示される（628件）
- [ ] フィルター（Person / Scene / Tag / Favorite）が動作する
- [ ] 検索（q パラメータ）が動作する
- [ ] URL フィルター sync：ブラウザの Back / Forward でフィルターが復元される
- [ ] 画像クリック → DetailPanel（desktop）/ Drawer（mobile）が開く
- [ ] Prompt 編集 → originalBody が変わらず currentBody が更新される

### Quick Add
- [ ] 画像アップロード → Gallery に反映される
- [ ] 重複チェックが動作する

### Masters
- [ ] Person / Scene / Tag 一覧が表示される
- [ ] imageCount > 0 のマスタは削除できない（400 エラー）
- [ ] 削除・統合が正常に動作する

### Import
- [ ] `/import` に CLI 注意バナーが表示される
- [ ] XLSX ファイルアップロード → 解析プレビューが表示される

### セキュリティ
- [ ] `/dev/api-check` → **404** が返る（ENABLE_DEV_API_CHECK 未設定）
- [ ] Storage URL に直接アクセス → **403** が返る（Private bucket）
- [ ] DevTools の Network タブで `SUPABASE_SERVICE_ROLE_KEY` が露出していない

### CLI 動作確認（ローカルから本番 DB に対して）
- [ ] `npm run audit:storage-assets -- --workspace-id <id> --dry-run` Missing 0 / Orphan 0

---

## 7. /dev/api-check — 本番無効化の仕組み

```typescript
// src/app/dev/api-check/page.tsx
if (process.env.ENABLE_DEV_API_CHECK !== "true") notFound();
```

| 環境 | `ENABLE_DEV_API_CHECK` | `/dev/api-check` |
|------|----------------------|-----------------|
| ローカル（`.env.local`）| `true` | 表示される ✅ |
| Vercel Production | 未設定 or `false` | **404** ✅ |
| Vercel Preview | 未設定 or `false` | **404** ✅ |

---

## 8. XLSX Import — ローカル CLI 運用方針

本番 Vercel ではXLSX画像インポートを実行しません。

```
理由:
- Vercel Functions に 200MB 級ファイルをアップロードするのは非推奨
- Import は冪等スクリプトで管理されており、ローカルから本番 DB に直接書き込む
- Google Drive 共有リンクからの直接インポートは未対応
```

**ローカル CLI での Import 手順:**

```bash
cd /Volumes/Extreme\ SSD/photobox/app

# 1. 解析（dry-run）
npm run extract:xlsx-batch -- --dry-run

# 2. 特定 XLSX のみ（部分一致）
npm run extract:xlsx-batch -- --only <partial-filename>

# 3. Import（dry-run → 確認後に本実行）
npm run import:xlsx-batch -- --dry-run
npm run import:xlsx-batch
```

詳細は [`docs/XLSX_IMPORT_RUNBOOK.md`](./XLSX_IMPORT_RUNBOOK.md) を参照。

---

## 9. セキュリティチェックリスト

```bash
# 実キーが docs / README / .env.example に混入していないか確認
grep -rn "eyJ" docs/ README* .env.example .env.migrate.example 2>/dev/null \
  && echo "⚠️ JWT が見つかりました" || echo "✅ 実JWT なし"

grep -rn "sb_secret_\|sb_publishable_" docs/ README* .env.example .env.migrate.example 2>/dev/null \
  && echo "⚠️ Supabase key が見つかりました" || echo "✅ Supabase key なし"

grep -rn "postgresql://.*:[^@\[]\+@" docs/ README* .env.example .env.migrate.example 2>/dev/null \
  && echo "⚠️ DB パスワードが見つかりました" || echo "✅ DB パスワードなし"

# .env.local が Git に含まれていないか
git ls-files | grep "\.env\.local" && echo "⚠️ .env.local が Git に含まれています" || echo "✅ .env.local は Git 管理外"
```

---

## 10. ロールバック手順

### Vercel ロールバック（即時）

Vercel Dashboard > Deployments > 対象デプロイ > **Promote to Production**

### DB マイグレーションを伴う変更のロールバック

1. Vercel でアプリをロールバック
2. DB は `docs/BACKUP.md` の手順でリストア

> DB マイグレーションを伴うデプロイは必ずバックアップを取得してから実施すること。

---

*最終更新: Day 10 Production Hardening (2026-06-30)*
