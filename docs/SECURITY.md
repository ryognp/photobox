# Photobox — Secrets 管理・セキュリティ運用

---

## SUPABASE_SERVICE_ROLE_KEY の保管ルール

`SUPABASE_SERVICE_ROLE_KEY` は Supabase のサーバー専用管理キー。
private bucket `photobox-private` の signed URL 発行に必須。

**保管・利用のルール:**

- `NEXT_PUBLIC_` prefix を絶対につけない（ブラウザに露出する）
- GitHub / Slack / チャット / ドキュメント / スクリーンショットに貼らない
- `.env.local` / `.env.migrate` は Git コミットしない（`.gitignore` 対象）
- Vercel Dashboard → Project Settings → Environment Variables にのみ設定
- ローカル共有が必要な場合は 1Password 等のパスワードマネージャーを使う
- コードに直書きしない

---

## 使用箇所（サーバー専用）

`SUPABASE_SERVICE_ROLE_KEY` は以下のサーバーサイドコードのみで使用:

| ファイル | 用途 |
|---|---|
| `src/lib/supabase/admin.ts` | 管理クライアント初期化（遅延実行） |
| `src/app/api/images/route.ts` | signed URL 発行 |
| `src/app/api/images/[id]/route.ts` | signed URL 発行 |
| `src/lib/signedUrl.ts` | signed URL 共通関数 |
| `src/app/api/uploads/commit/route.ts` | Storage temp ファイル削除 |
| `src/app/api/uploads/items/route.ts` | Storage アップロード処理 |
| `src/app/api/uploads/cleanup/route.ts` | Storage 孤立ファイル削除 |
| `src/lib/commit/storageCopy.ts` | Storage コピー・削除 |

**すべてサーバー専用（`import "server-only"` または API Route）**。

ブラウザ bundle に含まれていないことの確認:

```bash
# NEXT_PUBLIC_ 付きで誤設定していないか確認
grep -r "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY" /Volumes/Extreme\ SSD/photobox/app/

# クライアントコード（use client）に import されていないか確認
grep -r "service_role\|supabaseAdmin" /Volumes/Extreme\ SSD/photobox/app/src \
  --include="*.tsx" --include="*.ts" \
  | grep -v "server-only\|api/\|lib/supabase/admin\|lib/signedUrl\|lib/commit\|generated"
```

---

## 漏洩時の対応手順

キーが外部に漏洩した、または漏洩した可能性がある場合:

1. **即時 Regenerate**
   - Supabase Dashboard → Settings → API → service_role → **Regenerate**

2. **Vercel の環境変数を更新**
   - Production / Preview / Development すべての `SUPABASE_SERVICE_ROLE_KEY` を新しい値に更新
   - 更新後は **Redeploy** が必要

3. **ローカル `.env.local` を更新**
   - 新しい service_role key に差し替え
   - dev server を再起動

4. **漏洩範囲の確認**
   ```bash
   # repo history に値が含まれていないか確認（値のプレフィックスで検索）
   git log --all -p | grep -i "service_role"

   # docs / README に値が混入していないか確認
   grep -r "service_role" /Volumes/Extreme\ SSD/photobox/app/docs/
   grep -r "service_role" /Volumes/Extreme\ SSD/photobox/README.md
   ```

5. **動作確認**
   - `/gallery` で画像が表示されること（signed URL が正常発行されること）

6. **必要に応じて**
   - GitHub → Settings → Secret scanning alerts を確認
   - 旧キーが GitHub history に含まれている場合は history rewrite を検討

---

## ローテーション方針

| タイミング | 対応 |
|---|---|
| 漏洩時 / 漏洩疑い時 | 即時 Regenerate |
| 担当者変更時 | Regenerate を推奨 |
| 定期ローテーション | 3〜6か月に一度を推奨 |

ローテーション後は必ず `/gallery` の画像表示を確認すること。

---

## その他の環境変数

| 変数名 | 種別 | 備考 |
|---|---|---|
| `DATABASE_URL` | サーバー専用 | Supabase Transaction Pooler URI（password 含む） |
| `DIRECT_URL` | サーバー専用 | Supabase Session Mode URI（password 含む） |
| `SUPABASE_SERVICE_ROLE_KEY` | サーバー専用 | private bucket 操作に必須 |
| `NEXT_PUBLIC_SUPABASE_URL` | 公開可 | Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 公開可 | anon/public key |
| `NEXT_PUBLIC_SITE_URL` | 公開可 | サイト URL |
| `ENABLE_DEV_API_CHECK` | 非機密 | Production は `false` |

`DATABASE_URL` と `DIRECT_URL` には DB password が含まれるため、`SUPABASE_SERVICE_ROLE_KEY` と同様に扱う。

---

## Rate Limit（post-auth）

`src/lib/rateLimit.ts` + `src/lib/rateLimitCore.ts` により、heavy endpoint に post-auth の
user/workspace ベース rate limit を適用している（Upstash Redis sliding window）。

| ルート | プリセット | 制限 |
|---|---|---|
| `POST /api/uploads/items` | `uploadItem` | 60/min/user |
| `POST /api/uploads/commit` | `uploadCommit` | 10/min/user |
| `POST /api/import/parse` | `importParse` | 10/min/user/workspace |
| `GET /api/images` | `galleryRead` (300/min) | **現在未適用**（定義のみ） |

運用上の注意:

- この rate limit は **post-auth user/workspace ベースの制限であり、未認証DoS対策ではない**。
  未認証DoS対策には、将来的に middleware/proxy レイヤーで IP ベース制限を追加する。
- **Redis 未設定・Redis 障害時は fail-open** する（リクエストは通る）。
  本番では perf log の `rateLimitEnabled` / `rateLimitSource` で有効性を確認する。
  本番で Redis 未設定の場合は起動後最初のチェック時に `console.warn` が一度出る。
- Redis key は userId/workspaceId の SHA-256 ハッシュ（生値は Redis に出さない）。
- 429 レスポンスには `Retry-After` / `X-RateLimit-*`（Reset は epoch 秒）/ `Cache-Control: no-store` が付く。
- rate limit helper は Node.js runtime API route 用。Edge runtime で使う場合は
  hash 実装を WebCrypto に置き換える必要がある。

Known issue: rate limit は回数制限であり、単発の巨大ファイル投入は防げない。
`/api/import/parse` は 4MB 上限があるが、他ルートのボディサイズ上限は別タスクで確認する。

---

## 関連ドキュメント

| ファイル | 内容 |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Vercel 環境変数の設定手順 |
| [OPERATIONS.md](OPERATIONS.md) | service_role key の運用メモ |
| [BACKUP.md](BACKUP.md) | DB / Storage バックアップ方針 |
