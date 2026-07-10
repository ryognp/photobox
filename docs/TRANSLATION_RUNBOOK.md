# Prompt 翻訳 provider Runbook（Phase 10-9C）

DetailPanel の単体 prompt 翻訳（英語 prompt → 日本語訳）で使う実 OpenAI 翻訳
provider の env・有効化手順・監視・rollback。AI タグ解析の
[AI_ANALYSIS_RUNBOOK.md](AI_ANALYSIS_RUNBOOK.md) と対称の構成。

**現状（Phase 10-9C-2 時点）:**
- 実 OpenAI 翻訳 provider の**基盤のみ実装済み**（provider / factory / cost guard /
  `translatePrompt` rate limit preset）。
- **UI（「日本語訳を追加」ボタン）と単体翻訳 API（`POST /api/images/[id]/translate-prompt`）は
  未実装**（Phase 10-9C-3 / 10-9C-4）。
- 一括翻訳 `/api/prompts/translate-batch` は**引き続き mock 固定**（実 provider 化は別フェーズ）。
- 本番デフォルトは `TRANSLATION_ENABLED` 未設定 = **mock**。実翻訳は行われない。

**大原則:**
- 本番 env の設定・変更、Vercel / Supabase 操作、本番 DB / SQL はすべて**ユーザー操作**。
  担当エージェントは本番 env / DB / Storage / Supabase / Vercel 設定に触れない。
- 元の英語 prompt（`current_body` / `original_body`）は**絶対に上書きしない**。訳は
  `translated_body_ja` 等の翻訳キャッシュ列にのみ保存する。
- `[MOCK-JA]` 訳を本番 DB に保存しない = **mock の間は UI ボタンを出さない**
  （下記 `isTranslationEnabled` の厳格ゲート）。

---

## 環境変数

| 変数 | 意味 | デフォルト |
|---|---|---|
| `TRANSLATION_ENABLED` | `"true"` で実翻訳 provider 有効化。killswitch（最優先） | `false`（= mock） |
| `TRANSLATION_PROVIDER` | `mock` \| `openai` | `mock` |
| `TRANSLATION_MODEL` | OpenAI モデル名 | `gpt-4o-mini` |
| `TRANSLATION_OPENAI_API_KEY` | 翻訳専用キー（任意）。未設定なら `OPENAI_API_KEY` に fallback | なし |
| `OPENAI_API_KEY` | 上記未設定時の fallback（AI 解析と共用） | なし |
| `TRANSLATION_DAILY_CALL_LIMIT` | workspace/日あたりの実翻訳呼び出し上限（cost guard） | `20` |
| `TRANSLATION_TIMEOUT_MS` | provider 呼び出し timeout | `60000` |
| `TRANSLATION_MAX_INPUT_CHARS` | provider へ渡す入力の最大文字数 | `8000` |

Redis（`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`）は cost guard の前提。
**未設定だと cost guard が fail-closed で翻訳が `translation budget unavailable` になる。**

### UI 露出ゲート（厳格）

DetailPanel の「日本語訳を追加」ボタン（10-9C-4）は、`isTranslationEnabled(env)` が
**true の時だけ**露出する。true の条件は次の 3 つすべて:
- `TRANSLATION_ENABLED === "true"`
- `TRANSLATION_PROVIDER === "openai"`
- `TRANSLATION_OPENAI_API_KEY` または `OPENAI_API_KEY` が存在

provider が mock の場合は必ず false → mock 訳が本番 DB に入る経路が構造的に塞がれる。

---

## 本番有効化手順（ユーザー操作・順序厳守・10-9C-3/4 実装後）

キー未設定のまま `ENABLED=true` にしないため、**有効化フラグを最後に**。

1. `TRANSLATION_OPENAI_API_KEY`（任意・専用キーを使う場合）または既存 `OPENAI_API_KEY` を確認
2. `TRANSLATION_PROVIDER=openai`
3. （任意）`TRANSLATION_MODEL` / `TRANSLATION_DAILY_CALL_LIMIT`（初回は小さく、例 5〜10）
4. `UPSTASH_REDIS_REST_URL` / `TOKEN` が本番に設定済みか確認
5. **最後に** `TRANSLATION_ENABLED=true`
6. 再デプロイ

---

## エラー別 一次対応（`Prompt.translation_error`）

| error 値 | 意味 | 一次対応 |
|---|---|---|
| `translation provider timeout` | OpenAI 遅延 / timeout 不足 | `TRANSLATION_TIMEOUT_MS` 確認、OpenAI 遅延確認 |
| `translation provider rate limited` | OpenAI 429 | OpenAI usage / rate limit 確認 |
| `translation provider unavailable` | OpenAI 5xx | OpenAI 障害。時間をおく |
| `translation budget unavailable` | Redis 未設定 / 障害（fail-closed） | Upstash 確認 |
| `translation daily budget exceeded` | 日次上限到達（正常ガード） | `TRANSLATION_DAILY_CALL_LIMIT` 調整 |
| その他 | sanitize 済みメッセージ | 個別確認 |

- OpenAI usage / コストは **OpenAI ダッシュボード**、Redis 可用性は **Upstash コンソール**で確認。
- provider の raw response / usage / token / request id / headers / API キーは
  **返さない・保存しない・ログしない**（訳文テキストのみ保存）。

---

## rollback

- **即時無効化:** `TRANSLATION_ENABLED=false` → 再デプロイ。以後 mock（実翻訳停止・課金停止）。
  - 注: これは「OpenAI 翻訳課金の停止」であり、`isTranslationEnabled` が false になるため
    DetailPanel の翻訳ボタンも非表示に戻る。
- **二重の保険:** `TRANSLATION_PROVIDER=mock`。
- **キー漏洩時:** OpenAI / Vercel でキーをローテーション。
- schema 変更なし = DB レベル rollback 不要。cost guard カウンタは Redis のみ（日次 TTL）。
- 既に保存された実訳（`translated_body_ja`）は無効化後も残るが、元 prompt は不変で害はない。
  原文編集時は既存仕様どおり翻訳キャッシュが無効化される。

---

## 検証環境 / Preview での疎通（10-9C-3/4 実装後）

検証環境 `.env.local`（本番と別・git に入れない）に
`TRANSLATION_ENABLED=true` / `TRANSLATION_PROVIDER=openai` / `TRANSLATION_MODEL=gpt-4o-mini` /
`OPENAI_API_KEY`（ユーザー設定）/ `TRANSLATION_DAILY_CALL_LIMIT=5` + Upstash Redis を設定し、
英語 prompt 画像で「日本語訳を追加」→ 実日本語訳が入る / `[MOCK-JA]` でない / 原文非上書き /
DB に生レスポンスが残らないこと（SQL）を確認する。
