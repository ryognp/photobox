# AI タグ解析 provider 本番有効化 Runbook（Phase 10-5D-3）

`POST /api/images/[id]/analyze` の実 OpenAI provider を本番で有効化する前の手順書と
少数 QA チェックリスト。env 変数の一覧・意味は [OPERATIONS.md](OPERATIONS.md) の
「AI タグ解析 provider」節を参照。

**前提:** Phase 10-5D-1 / 10-5D-2 は main merge 済み。本番は現在
`AI_ANALYSIS_ENABLED=false` で mock provider 継続（実 OpenAI 未接続）。

**大原則:**
- 本番 env の設定・変更、Vercel / Supabase ダッシュボード操作、本番 DB / Storage 設定、
  本番 SQL 実行は**すべてユーザー操作**。担当エージェント（Claude）は本番 env / 本番 DB /
  Storage / Supabase / Vercel 設定には触らない（コード修正・feature branch 実装・
  ゲート実行までが担当範囲。有効化スイッチは常にユーザーの手元）。
- 「有効化フラグ `AI_ANALYSIS_ENABLED=true` は最後に設定する」が事故防止の要。

---

## 1. ローカル / 検証環境での疎通確認（本番より前に必須）

本番 env を変える前に、検証環境で実 OpenAI 接続を先に確認する。

1. 検証環境の `.env.local`（本番とは別・git に入れない）に設定:
   ```
   AI_ANALYSIS_ENABLED=true
   AI_ANALYSIS_PROVIDER=openai
   AI_ANALYSIS_MODEL=gpt-4o-mini
   OPENAI_API_KEY=sk-...            # 検証用キー（本番と別・低予算上限が望ましい）
   AI_ANALYSIS_DAILY_CALL_LIMIT=20  # 検証は小さめ
   ```
   ※ Upstash Redis（`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`）も設定すること。
   **未設定だと cost guard が fail-closed になり、解析が `analysis budget unavailable` で
   全 FAILED になる**（設計通りだが疎通確認にならないため必ず設定）。
2. `npm run build && npm start`（または dev）で起動。
3. 英語 prompt のある画像を1枚選び「AI 解析する」→ 日本語タグ候補が出ることを確認。
4. サーバーログに OpenAI のエラー・timeout が出ていないこと。
5. **キー空の config_error 確認は、未 cached 画像または「強制再解析」で行う**（下記注意）。
6. 確認後、検証用キーの使用状況を OpenAI ダッシュボードで確認（想定件数以内か）。

**この段階で異常があれば本番へ進まない。**

> **注意（cached との関係）:** analyze route では **cached 判定が config_error 処理より前**。
> そのため既存 DONE cache がある画像では、`OPENAI_API_KEY` を空にしても cached が返り、
> config_error にならない可能性がある。キー空の config_error 確認は必ず
> **未 cached 画像**、または `?force=1` / 「強制再解析」で cached を避けて行うこと。

---

## 2. 本番 Vercel env 設定順序（ユーザー操作・順序厳守）

キー未設定のまま `ENABLED=true` にすると全 FAILED になるため、**有効化フラグを最後に**。

1. `OPENAI_API_KEY` = 本番用キー（Production scope）
2. `AI_ANALYSIS_PROVIDER=openai`
3. （任意）`AI_ANALYSIS_MODEL=gpt-4o-mini`（省略時デフォルト同値）
4. （任意）`AI_ANALYSIS_DAILY_CALL_LIMIT=100`（初回は小さめ推奨、例 `30`〜`50`）
5. （前提確認）`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` が本番に設定済みであること。
   **未設定だと cost guard が fail-closed で解析が `analysis budget unavailable` になる。**
6. **最後に** `AI_ANALYSIS_ENABLED=true`
7. env 変更を反映するため再デプロイ。

> 途中で中断する場合、`AI_ANALYSIS_ENABLED` を設定しなければ mock のまま。1〜5 を入れても
> `ENABLED` 未設定なら本番挙動は変わらない。

---

## 3. 少数画像 QA 項目（有効化直後）

対象は**まず 2〜3 枚**に限定。基本は正常系の確認を優先する。

- [ ] 英語 prompt の画像で「AI 解析する」→ **日本語**タグ候補が 5 件前後表示される（英単語そのままでない）。
- [ ] 翻訳済み（`translatedBodyJa` 有効）画像で解析 → 日本語入力ベースの候補になる（10-5C 連携）。
- [ ] prompt なし画像 → `SKIPPED_NO_PROMPT`（候補 0・FAILED 表示ではない）。
- [ ] 候補の「承認」→ 正式 Tag 作成、「却下」、「編集して承認」が従来通り動く（10-5A / 10-3）。
- [ ] 同じ画像を再度解析 → `cached: true`（同一 prompt hash・modelId）で即返り、**budget を消費しない**。
- [ ] 「強制再解析」→ 新規 provider 呼び出しになる（cached でない）。
- [ ] 人物が写っていそうな prompt でも、**年齢・性別・人種などの属性タグが出ない**
      （system prompt + denylist の二重防御）。

---

## 4. budget / cost guard 確認

**上限超過テストは原則として検証環境で実施する。**

- [ ]（検証環境）`AI_ANALYSIS_DAILY_CALL_LIMIT` を小さい値（例 3）に設定 → 上限超過後の解析が
      **FAILED: `analysis daily budget exceeded`** になる。
- [ ] cached 応答は上限に**カウントされない**（上限到達後でも既存 DONE は cached で返る）。
- [ ] mock 時（`ENABLED=false` or `PROVIDER=mock`）は budget を消費しない。
- [ ] （任意）解析成功レスポンスの `budget.remaining` が想定通り減る（ネットワークタブで確認、UI 表示なし）。
- [ ] Redis（Upstash）に `budget:analysis:<UTC日付>:<hash>:openai:openai:gpt-4o-mini:ja-tags-v1`
      のようなキーが日付単位で作られ、TTL が付いていること（任意・Upstash コンソール）。

> **本番で上限テストをする場合の注意:** budget 予約は Redis `INCR` で、**provider 失敗時も
> カウントを戻さない**設計。本番で `AI_ANALYSIS_DAILY_CALL_LIMIT=3` のようなテストをすると
> **当日の Redis カウンタが消費され、戻らない**。本番初回 QA では上限テストを避け、少数画像の
> 正常系確認を優先すること。上限テストが必要なら検証環境で行う。テスト後は運用値に戻す。

> **cost guard の error 文言（統一）:**
> - Redis 未設定 / 障害時（fail-closed）→ `analysis budget unavailable`
> - 日次上限超過 → `analysis daily budget exceeded`

---

## 5. FAILED 表示確認

- [ ] provider timeout 時（検証環境で `AI_ANALYSIS_TIMEOUT_MS` を極小にして誘発）→
      FAILED: `analysis provider timeout` が UI 表示される。
- [ ] OpenAI 429 → FAILED: `analysis provider rate limited`（固定文言に正規化）。
- [ ] OpenAI 5xx → FAILED: `analysis provider unavailable`（固定文言に正規化）。
- [ ] **キー不正 / 権限エラー（401 / 403 などその他 4xx）は HTTP 500 ではなく、
      sanitize 済みの FAILED として表示される**（固定文言ではなく、秘匿情報をマスクした
      メッセージ）。
- [ ] FAILED のエラーメッセージに **API キー等の秘匿情報が出ていない**（`sanitizeAnalysisError`）。
- [ ] FAILED 後に「強制再解析」で復帰できる。
- [ ] budget 超過 FAILED（`analysis daily budget exceeded`）・config_error FAILED も同様に UI 表示される。

---

## 6. rawJson 確認 SQL（Supabase・ユーザー実行・読み取りのみ）

有効化後に実 OpenAI で DONE になった行を検査:

```sql
SELECT id, model_id, status, raw_json
FROM image_analyses
WHERE model_id LIKE 'openai:%'
  AND status = 'DONE'
ORDER BY updated_at DESC
LIMIT 5;
```

確認ポイント:
- [ ] `raw_json` のキーが **`tags` / `keywords_ja` / `keywords_en` / `usage_category` /
      `language_detected` のみ**（filter 後の構造化 JSON）。
- [ ] `usage` / `total_tokens` / `request_id` / provider の生 `id` / `model`(生) / `headers` 等の
      **provider 生メタデータが含まれない**。
- [ ] `raw_json` 内のタグ / キーワードが画面表示の候補と一致（denylist 除去済みで、人物属性語が残っていない）。

schema_validation_failed の FAILED 行も検査:

```sql
SELECT id, status, error, raw_json
FROM image_analyses
WHERE model_id LIKE 'openai:%' AND status = 'FAILED'
ORDER BY updated_at DESC
LIMIT 5;
```

- [ ] `error = 'schema_validation_failed'` の行は **`raw_json` が NULL**（検証前の生出力は保存しない）。

> これらはすべて**読み取り専用 SELECT**。担当エージェントは本番 DB に接続しない。ユーザーが
> Supabase SQL Editor で実行する。

---

## 7. rollback 手順（問題発生時・ユーザー操作）

即応の速い順:

1. **即時無効化**: `AI_ANALYSIS_ENABLED=false` に変更 → 再デプロイ。以後は mock provider に復帰
   （コード変更不要）。
2. **二重の保険**: 併せて `AI_ANALYSIS_PROVIDER=mock` に戻す。
3. **キー漏洩時**: OpenAI / Vercel でキーをローテーション（コード変更不要）。
4. **コストが想定超**: `AI_ANALYSIS_DAILY_CALL_LIMIT` を下げる、または `ENABLED=false`。
5. **データ**: schema 変更なし・DB レベル rollback 不要。実 OpenAI 行は modelId が `openai:...` で
   mock 行（`mock:...`）と別管理のため、無効化しても mock 解析は従来通り共存。budget カウンタは
   Redis のみ（日次 TTL で自然消滅）。

> mock 時代に承認済みの英語 Tag は自動変更されない（既存方針）。日本語へ揃えたい場合はユーザーが手動で見直す。

---

## 8. 担当エージェント（Claude）の非接触制約

- 本番 Vercel env の設定・変更は**ユーザーのみ**。エージェントは行わない。
- 本番 DB / Storage / Supabase 設定の操作、本番 SQL 実行（§6 の検査 SELECT 含む）は**ユーザーのみ**。
- 本番 migration は無関係（Phase 10-5D 系は schema 変更なし）。
- エージェントが行うのは、問題が出た際の**コード修正提案・feature branch 実装・ゲート実行**まで。
  有効化スイッチは常にユーザーの手元。

---

## 9. 本番運用監視（Phase 10-5G）

本番 OpenAI 解析の状態・失敗・使用状況・危険兆候を確認するための監視手順。**すべて
読み取り専用 SELECT で、ユーザーが Supabase SQL Editor で実行する**（エージェントは
本番 DB に接続しない — §8）。現状は SQL のみで運用し、専用の ops API / ops 画面は作らない。

### 情報源の切り分け

- **FAILED / 解析件数 / 候補件数 → DB（下記 SQL）が一次情報源。** FAILED は analyze route が
  HTTP 200 + `status:"FAILED"` で返すため **Vercel logs には出ない**。
- **Vercel logs は 500 系の想定外エラー確認用**（`[analyze] persistence error`）。FAILED 監視には使わない。
- **OpenAI の使用量・コスト → OpenAI ダッシュボード**（DB では取得不可。予算アラート推奨）。
- **Redis 可用性 → Upstash コンソール**（`budget:analysis:<UTC日付>:<hash>:openai:...` キーの増加・TTL）。

### 監視 SQL（読み取り専用）

> **複数 workspace 運用に移行した場合は、各 SQL に `WHERE workspace_id = '<id>'`（または既存
> 条件へ AND 追加）を足すこと。** 以下は単一 workspace 前提で `workspace_id` 条件を省略している。

```sql
-- (1) 直近24h の status 別件数
SELECT status, count(*) FROM image_analyses
WHERE updated_at >= now() - interval '24 hours'
GROUP BY status ORDER BY count(*) DESC;

-- (2) 直近24h の FAILED を error 別に内訳
SELECT error, count(*) FROM image_analyses
WHERE status = 'FAILED' AND updated_at >= now() - interval '24 hours'
GROUP BY error ORDER BY count(*) DESC;

-- (3) model_id × status 別件数（model_id LIKE 'openai:%' が実 OpenAI 分）
SELECT model_id, status, count(*) FROM image_analyses
GROUP BY model_id, status ORDER BY model_id, status;

-- (4) TagSuggestion の status 別件数（PENDING 滞留の把握）
SELECT status, count(*) FROM tag_suggestions GROUP BY status;

-- (5) 直近の FAILED 一覧
SELECT id, image_id, model_id, error, updated_at FROM image_analyses
WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 20;

-- (6) daily budget exceeded の有無（直近24h）
SELECT count(*) FROM image_analyses
WHERE error = 'analysis daily budget exceeded' AND updated_at >= now() - interval '24 hours';

-- (7) 24h FAILED 率
SELECT
  count(*) FILTER (WHERE status = 'FAILED') AS failed,
  count(*) AS total,
  round(100.0 * count(*) FILTER (WHERE status = 'FAILED') / nullif(count(*), 0), 1) AS failed_pct
FROM image_analyses WHERE updated_at >= now() - interval '24 hours';

-- (8) 日別解析件数（トレンド）
SELECT date_trunc('day', created_at) AS day, count(*) FROM image_analyses
GROUP BY day ORDER BY day DESC LIMIT 14;

-- (9) rawJson 確認（§6 と同じ・safeRaw のみか）
SELECT id, model_id, status, raw_json FROM image_analyses
WHERE model_id LIKE 'openai:%' AND status = 'DONE' ORDER BY updated_at DESC LIMIT 5;
```

### エラー別 一次対応表（`image_analyses.error`）

| error 値 | 意味 | 一次対応 |
|---|---|---|
| `analysis provider timeout` | OpenAI 遅延 / timeout 不足 | OpenAI 遅延を確認、`AI_ANALYSIS_TIMEOUT_MS` を確認（本番既定 60000） |
| `analysis provider rate limited` | OpenAI 429 | OpenAI ダッシュボードで usage / rate limit を確認、時間をおく |
| `analysis provider unavailable` | OpenAI 5xx | OpenAI 側障害。時間をおいて再試行 |
| `analysis budget unavailable` | **Redis 未設定 / 障害**（fail-closed 発火） | Upstash コンソールで Redis を確認（設定ミスの可能性大） |
| `analysis daily budget exceeded` | 日次上限到達（正常なガード動作） | 想定内。必要なら `AI_ANALYSIS_DAILY_CALL_LIMIT` を調整 |
| `schema_validation_failed` | OpenAI 出力が JSON Schema 不適合 | 単発なら無視可。頻発なら prompt / schema 見直し（別フェーズ） |
| `OPENAI_API_KEY is not configured` | env 設定不足（config_error） | Vercel Production env の `OPENAI_API_KEY` を確認 |
| その他 | sanitize 済みメッセージ | (5) で個別確認 |

> FAILED が増えたら、まず (1)(2) で status / error 内訳を確認 → 上表で原因別に対応 →
> 判断がつかない / 深刻なら即 `AI_ANALYSIS_ENABLED=false` → redeploy（OpenAI 課金停止・
> mock 復帰。§7 の rollback 参照）。

### ops API / ops 画面へ移行するトリガー（将来・現時点では作らない）

次のいずれかが発生したら、別フェーズで ops API / 画面を設計する:
- SQL の手打ち実行が日次ルーティン化して負担になった
- 複数 workspace 運用になり横断集計が必要になった
- 非エンジニアの運用者が GUI で監視したい
