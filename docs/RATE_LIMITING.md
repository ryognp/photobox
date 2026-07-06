# Photobox — Rate Limiting / DoS 対策 運用チェックリスト（Phase 9B）

pre-auth / IP ベースのレート制限は **コードでは実装せず**、まずプラットフォーム層
（Vercel Firewall + Supabase Auth）で対応する方針（Phase 9A で決定）。
本書はその**運用チェックリスト**。設定変更は Vercel / Supabase のダッシュボードで行う。

> 前提: 全 API route は auth-first（重い処理の前に 401 を返す）で、upload/import 系は
> `auth → post-auth rate limit → parse` の順。**未認証での重処理 DoS 窓はアプリ層で既に小さい。**
> 真の DoS 対策はアプリコードよりプラットフォーム層が妥当、という判断（Phase 9A）。

---

## 1. Vercel 側で確認すべき項目

Vercel Dashboard → プロジェクト `photobox` → **Firewall**（または Settings → Security）。

- [ ] **Firewall が有効か**（Pro プランで利用可能）
- [ ] **Rate Limiting ルールの有無**
  - 全体（`/*`）への上限を置くか、まず `/api/*` に絞るか
  - **`/api/auth/*`（callback / complete）** への上限（総当り・スパム前段防御）
  - 初期値の目安（誤爆回避で緩め）: 全体 300 req/min/IP、`/api/auth/*` 30 req/min/IP
    ※ NAT/共有 IP を巻き込むため**緩めから開始し、ログを見て調整**
- [ ] **Attack Challenge Mode** の有無と発動条件（攻撃検知時のみ手動/自動で有効化できるか）
- [ ] **Bot 対策 / Managed ルール**の有無
- [ ] **除外設定**
  - `/api/cron/*` は **IP 制限対象外にする**（Vercel Cron の送信 IP は固定でなく誤爆する）
  - static / `_next/*` / 画像アセットは対象外
- [ ] **誤ブロック時の運用**
  - ブロックログの確認場所（Firewall のイベントログ）
  - 特定 IP の許可（allowlist）/ ルール一時無効化の手順
  - ルール変更の反映は再デプロイ不要か（通常は即時）
- [ ] IP は Vercel が `x-forwarded-for` 先頭に信頼値を付与する前提を確認

## 2. Supabase Auth 側で確認すべき項目

Supabase Dashboard → Authentication → **Rate Limits**（および Providers / Email 設定）。
※ login / signup は**クライアントが Supabase に直接**リクエストする（自前 API を経由しない）。
　したがって **Supabase 側のレート制限が login/signup の主防御**。

- [ ] **各操作の現在値を記録**（変更前のスナップショット）
  - sign in（password）
  - sign up
  - password recovery / reset
  - OTP / magic link 送信
  - email 再送
  - token refresh
- [ ] **メール送信系**の上限（signup / reset / OTP のスパム = メール爆撃防止）
- [ ] 現在値が**デフォルトのままか、調整済みか**
- [ ] 推奨確認観点
  - 単一 IP / 単一アカウントからの試行回数上限が妥当か
  - メール送信上限が低すぎて正規ユーザーを妨げないか（誤爆観点）
  - CAPTCHA（hCaptcha/Turnstile）連携の有無（総当り対策として有効だが UX 影響あり）
- [ ] 変更した場合は**変更内容と日付を本書 or 運用ログに記録**

## 3. 現状のアプリ側防御（実装済み・参考）

| 層 | 内容 | 場所 |
|---|---|---|
| auth-first | 全 API route が先頭で `getCurrentUser()`/`requireUser()` → 未認証は 401（重処理前） | 各 `route.ts` |
| post-auth rate limit | upload/import/commit に user/workspace 単位の sliding window（fail-open） | `src/lib/rateLimit.ts` / `rateLimitCore.ts` |
| rate limit 適用箇所 | `uploadItem` 60/min, `uploadCommit` 10/min, `importParse` 10/min（いずれも auth 後・parse 前） | `uploads/items`, `uploads/commit`, `import/parse` |
| cron 認証 | `CRON_SECRET` Bearer（constant-time 比較・fail-closed） | `api/cron/*` |
| workspace 分離 | 全 query が workspaceId スコープ（Phase 8: `withWorkspaceWhere` / `resolveWorkspaceImage`） | `src/lib/workspace`, `src/lib/images` |

**現状の穴（把握済み）**: 未認証リクエストでも Function は起動する（401 を返すまでの起動コスト）。
login/signup は Supabase 直叩きのためアプリ側で制限できない。→ 上記 1/2 のプラットフォーム層で対応。

## 4. 案C（auth 系2本への pre-auth IP 制限）を実装する判断基準

以下の**いずれか**が観測されたら、案C のコード実装を検討する:

- [ ] `/api/auth/callback` / `/api/auth/complete` への**単一 IP からの大量アクセス**（Vercel ログ）
- [ ] **401 / 403 の急増**（総当り・スキャンの兆候）
- [ ] **Supabase Auth 側のレート制限だけでは不足**と判断（メール爆撃・アカウント総当りが止められない）
- [ ] Vercel Firewall の設定だけでは `/api/auth/*` を十分に守れない、または誤爆が多くルールを緩めざるを得ない
- [ ] Function 起動数（未認証由来）が課金・性能面で無視できない水準

上記が無ければ**実装しない**（YAGNI / 誤爆リスク回避）。

## 5. 今は実装しない理由

- 全 API route が auth-first で、**未認証の重処理 DoS 窓はアプリ層で既に小さい**。
- middleware 全体 IP 制限（案A）は **NAT 誤爆 / Edge runtime 制約（既存 `rateLimitCore` の `node:crypto` が使えず WebCrypto 書き換え要）/ 全経路 rollback 影響**が大きく、得られる耐性に見合わない。
- 真の DoS 防御は**ネットワーク/プラットフォーム層（Vercel Firewall・Supabase Auth）**の責務で、**コード変更ゼロ**で最も効果的。
- login/signup は Supabase 直叩きのため、そもそもアプリ側 IP 制限の対象外。
- 観測データ（実際の攻撃傾向）が無い段階で広く網をかけると誤爆リスクが先に立つ。

## 6. 将来 案C を実装する場合の最小設計メモ

（実装は判断基準を満たしてから。ここは設計メモのみ）

- **対象**: `/api/auth/callback`（GET）と `/api/auth/complete`（POST）の2本のみ。middleware は使わない（Node route のまま）。
- **core 拡張**: `src/lib/rateLimitCore.ts` に **IP identity 版**を追加。既存 `hashIdentity`（`node:crypto` SHA-256）を再利用可能（対象は Node runtime route なので Edge 制約なし）。
  - キー: `ratelimit:preauth-auth:<sha256(ip)>`（**生 IP は Redis/ログに残さない**）
  - preset 例: `authEndpoint` = 30/min/IP（緩め・初期値）
- **IP 取得**: `request.headers.get("x-forwarded-for")` の先頭 → fallback `x-real-ip` → 取れなければ `"unknown"`。
- **fail-open 継続**: Redis 未設定/障害/IP 取得不可 → 通す（正規ユーザーのログイン不能を避ける）。
- **配置**: auth の処理より前（route 冒頭）に IP 制限チェック。超過は 429 + `Retry-After`（既存 `rateLimitHeaders` 流用）。
- **除外**: cron は対象外（既に別 route・Bearer 認証）。
- **テスト**: core の IP 版を pure unit test（IP hash が生値を含まない / x-forwarded-for 先頭採用 / 取得不可→allow）。route 統合テストはしない。
- **rollback**: 2 route + core 追加のみ。revert 1コミットで復帰。DB/schema 変更なし。

---

## 決定サマリー（Phase 9A/9B）

- pre-auth IP 制限は **コード未実装**。Step 1 = **Vercel Firewall + Supabase Auth 設定**（プラットフォーム層）を先行。
- middleware 全体 IP 制限（案A）は**見送り**。
- 案C（auth 系2本）は **§4 の判断基準を満たしたら**検討。
- 設定変更は Vercel / Supabase ダッシュボードで実施（コード変更なし）。
