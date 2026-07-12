# Prompt バリエーション生成 provider Runbook（Phase 10-11）

DetailPanel で既存 prompt を元に「ポーズ / 服装 / 表情 / 場所 / 雰囲気・時間帯」を変えた
新しい画像生成 prompt 案を作る機能の env・有効化手順・監視・rollback。AI タグ解析の
[AI_ANALYSIS_RUNBOOK.md](AI_ANALYSIS_RUNBOOK.md) / prompt 翻訳の
[TRANSLATION_RUNBOOK.md](TRANSLATION_RUNBOOK.md) と対称の構成。

**現状（Phase 10-11C 時点 / main `12c4f91`）:**
- provider / factory / cost guard / rate limit（`promptVariation` preset）、単体生成 API
  **`POST /api/images/[id]/prompt-variations`**、DetailPanel UI（「プロンプトバリエーション」
  セクション + `PromptVariationModal`）を実装済み。
- **生成結果は一切 DB 保存しない**（`ImageAnalysis` や `Prompt` 相当の永続テーブルなし）。
  `Prompt.currentBody` は自動更新されず、`PromptVersion` も作られない。モーダル表示 + コピー
  のみ — 反映したい場合はユーザーが手動で PromptEditor に貼り付けて保存する。
- 本番デフォルトは `PROMPT_VARIATION_ENABLED` 未設定 = **mock**。実生成は行われない。

**大原則:**
- 本番 env の設定・変更、Vercel / Supabase 操作、本番 DB / SQL はすべて**ユーザー操作**。
  担当エージェントは本番 env / DB / Storage / Supabase / Vercel 設定に触れない。
- 元の画像生成 prompt（`Prompt.currentBody` / `originalBody`）は**絶対に上書きしない**。
- `PROMPT_VARIATION_ENABLED` が false（mock 含む）の間は UI ボタン自体を出さない
  （`isVariationEnabled` の厳格ゲート）。

---

## 環境変数

| 変数 | 意味 | デフォルト |
|---|---|---|
| `PROMPT_VARIATION_ENABLED` | `"true"` で実 provider 有効化。killswitch（最優先） | `false`（= mock） |
| `PROMPT_VARIATION_PROVIDER` | `mock` \| `openai` | `mock` |
| `PROMPT_VARIATION_MODEL` | OpenAI モデル名 | `gpt-4o-mini` |
| `PROMPT_VARIATION_OPENAI_API_KEY` | 専用キー（任意）。未設定なら `OPENAI_API_KEY` に fallback | なし |
| `OPENAI_API_KEY` | 上記未設定時の fallback（AI 解析・翻訳と共用） | なし |
| `PROMPT_VARIATION_DAILY_CALL_LIMIT` | workspace/日あたりの実生成呼び出し上限（cost guard） | `20` |
| `PROMPT_VARIATION_TIMEOUT_MS` | provider 呼び出し timeout | `60000` |
| `PROMPT_VARIATION_MAX_INPUT_CHARS` | provider へ渡す入力の最大文字数（超過は切り詰め、原文には影響しない） | `8000` |

Redis（`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`）は cost guard の前提。
**未設定だと cost guard が fail-closed で生成が `prompt variation budget unavailable` になる。**

### UI 露出ゲート（厳格）

DetailPanel の「プロンプトバリエーション」セクションは、`isVariationEnabled(env)` が
**true の時だけ**表示される。true の条件は次の 3 つすべて:
- `PROMPT_VARIATION_ENABLED === "true"`
- `PROMPT_VARIATION_PROVIDER === "openai"`
- `PROMPT_VARIATION_OPENAI_API_KEY` または `OPENAI_API_KEY` が存在

かつ画像に `prompt` がある場合のみ（`prompt` がない画像はセクション自体を表示しない）。
provider が mock の場合は必ず false → mock 出力（`[MOCK-VARIATION ...]`）がユーザーに
表示される経路は構造的に塞がれる。

---

## Preview / Production 有効化手順（ユーザー操作・順序厳守）

キー未設定のまま `ENABLED=true` にしないため、**有効化フラグを最後に**。

1. `PROMPT_VARIATION_OPENAI_API_KEY`（任意・専用キーを使う場合）または既存 `OPENAI_API_KEY` を確認
2. `PROMPT_VARIATION_PROVIDER=openai`
3. （任意）`PROMPT_VARIATION_MODEL` / `PROMPT_VARIATION_DAILY_CALL_LIMIT`（初回は小さく、例 5〜10）
4. `UPSTASH_REDIS_REST_URL` / `TOKEN` が対象環境に設定済みか確認
5. **最後に** `PROMPT_VARIATION_ENABLED=true`
6. **redeploy**（Vercel は env 変更をデプロイ時に Lambda へ焼き込むため、env を設定・変更しただけ
   では実行中の Production/Preview インスタンスには反映されない。**re-deploy が必須**）
7. redeploy 完了後、少数の画像で §QA手順 を実施してから広く使う

---

## QA 手順（ユーザーがログイン済みブラウザで実施）

1. Gallery で prompt がある画像を開く
2. DetailPanel に「プロンプトバリエーション」セクションが表示される
3. 未選択時、「新しいプロンプトを生成」が disabled
4. 1 つ以上選択でボタンが有効化
5. 「ポーズを変える」など 1〜2 項目を選んで生成
6. 生成中は「生成中...」になる
7. 成功時に modal が開く
8. 生成された prompt が表示される
9. **元 prompt が英語なら英語で出る**（勝手に日本語化されない）
10. コピーできる
11. 閉じるで modal が閉じる
12. PromptEditor の `currentBody` が変わっていない
13. Prompt 履歴（`PromptVersion`）が増えていない
14. ページ再読み込み後も元 prompt が変わっていない
15. mobile 幅でチェックボックスと modal が崩れない

**OpenAI / budget 消費を抑えるため、QA はまず 1〜2 件だけ行う。**

---

## エラー別 一次対応（API `error` フィールド）

| error 値 | 意味 | 一次対応 |
|---|---|---|
| `prompt variation provider timeout` | OpenAI 遅延 / timeout 不足 | `PROMPT_VARIATION_TIMEOUT_MS` 確認、OpenAI 遅延確認 |
| `prompt variation provider rate limited` | OpenAI 429 | OpenAI usage / rate limit 確認 |
| `prompt variation provider unavailable` | OpenAI 5xx | OpenAI 障害。時間をおく |
| `prompt variation budget unavailable` | Redis 未設定 / 障害（fail-closed） | Upstash 確認 |
| `prompt variation daily budget exceeded` | 日次上限到達（正常ガード） | `PROMPT_VARIATION_DAILY_CALL_LIMIT` 調整 |
| その他 | sanitize 済みメッセージ | 個別確認 |

- OpenAI usage / コストは **OpenAI ダッシュボード**、Redis 可用性は **Upstash コンソール**で確認。
- provider の raw response / usage / token / request id / headers / API キーは
  **返さない・保存しない・ログしない**（生成 prompt テキストのみ返す）。
- API はクライアントに budget の残数（`remaining`）を返さない（内部制御のみ）。

---

## rollback

- **即時無効化:** `PROMPT_VARIATION_ENABLED=false` → **redeploy**。以後 mock（実生成停止・課金停止）。
  - `isVariationEnabled` が false になるため、DetailPanel の「プロンプトバリエーション」
    セクションも非表示に戻る（UI が出ないことを redeploy 後に確認）。
- **二重の保険:** `PROMPT_VARIATION_PROVIDER=mock`。
- **キー漏洩時:** OpenAI / Vercel でキーをローテーション。
- schema 変更なし = DB レベル rollback 不要。生成結果を一切保存していないため、
  rollback 時に消去すべきデータも存在しない。cost guard カウンタは Redis のみ（日次 TTL）。

---

## 単体 prompt バリエーション API（`POST /api/images/[id]/prompt-variations`）

画像 1 件の `prompt.currentBody` を元に、選択した要素（`pose` / `outfit` / `expression` /
`place` / `mood_time`）だけを変えた新しい画像生成 prompt を生成する。
body: `{ changes: VariationChange[] }`（1〜5 件、重複不可、固定 enum のみ・自由記述不可）。

- 認証・存在・認可・validation・レート超過のみ非 200（401 / 403 / 404 / 400 / 429）。
  それ以外の業務状態はすべて **HTTP 200 + `{ status, variation }`** で返す。`status`:
  - `disabled` — `isVariationEnabled(env)` が false（mock 含む）。**DB / budget / provider に
    一切触れない**。`variation: null`。
  - `no_prompt` — prompt 未登録。`variation: null`。
  - `DONE` — 生成成功。`variation: { text }`。**`budget.remaining` は返さない**（API surface
    最小化、内部制御として扱う）。
  - `FAILED` — provider エラー / budget 拒否 / （想定外の）config_error。`error` に
    sanitize 済み文言。`variation: null`。
- 順序: auth → resolveWorkspaceImage → deleted/non-ACTIVE 404 → no_prompt → changes validation
  → **disabled early-return** → rate limit(`promptVariation`) → provider 解決 → config_error は
  FAILED → `reserveVariationBudget` → provider.generate → 結果を返す。
- **DB への書き込みは一切ない**（`Prompt.currentBody` 更新なし、`PromptVersion` 作成なし、
  `TagSuggestion` 等も非接触）。生成結果は呼び出しごとに使い捨てで、キャッシュもされない。
- 入力は `PROMPT_VARIATION_MAX_INPUT_CHARS` で truncate（provider 入力のみ、原文は不変）。
- provider の raw response / usage / token / headers / request id / API キーは
  返さない・保存しない・ログしない（生成 prompt テキストのみ）。

---

## 既知の制限

- **画像そのものは見ない**。`prompt.currentBody`（テキスト）のみを元に生成するため、
  実際の画像の見た目とは無関係に文章として妥当な変更案が作られる。
- **出力品質は provider 依存**。生成内容の正確さ・一貫性は保証されない。
- **反映はユーザーの手動操作**。モーダルからコピーした後、既存の PromptEditor で
  手動編集・保存する必要がある（自動反映・自動保存は行わない）。
