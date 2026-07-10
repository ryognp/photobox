# Prompt 翻訳 provider Runbook（Phase 10-9C）

DetailPanel の単体 prompt 翻訳（英語 prompt → 日本語訳）で使う実 OpenAI 翻訳
provider の env・有効化手順・監視・rollback。AI タグ解析の
[AI_ANALYSIS_RUNBOOK.md](AI_ANALYSIS_RUNBOOK.md) と対称の構成。

**現状（Phase 10-9C-5 時点 / main `215e23a`）:**
- 実 OpenAI 翻訳 provider の基盤（provider / factory / cost guard /
  `translatePrompt` rate limit preset）と、**単体翻訳 API
  `POST /api/images/[id]/translate-prompt`**、detail API の翻訳フィールド +
  `translationEnabled` フラグを実装済み（10-9C-2/3）。
- **DetailPanel の UI（「日本語訳を追加 / 再生成」）実装済み**（10-9C-4）。
  `translationEnabled === true` の時だけボタンを露出。表示は server 計算の
  `effectiveTranslatedBodyJa` のみ（stale 訳は非表示）。
- **翻訳 refusal guard + system prompt 強化を実装済み**（10-9C-5）。provider が拒否文を
  通常の output_text で返しても DONE 保存せず、`FAILED` +
  `translation_error="translation provider refused"` にする（`translated_body_ja` 非上書き）。
  system prompt は「翻訳専用・拒否禁止」に強化し、`TRANSLATION_PROMPT_VERSION=tr-v2`
  （modelId = `openai:gpt-4o-mini:tr-v2`）。
- Preview 環境で実翻訳 QA 済み（拒否文だったプロンプトが tr-v2 で正常翻訳・mock/拒否文非混入・
  原文非上書きを確認）。
- 一括翻訳 `/api/prompts/translate-batch` は**引き続き mock 固定**（実 provider 化は別フェーズ）。
- **本番デフォルトは `TRANSLATION_ENABLED` 未設定 = mock。Production はまだ有効化していない**
  （有効化手順は下記「Production enablement (Phase 10-9C-6)」）。

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
| `translation provider refused` | provider が翻訳せず拒否文を返した（10-9C-5 guard が検出し FAILED 化） | system prompt tr-v2 で通常は解消。増加時は refusal guard パターン拡充（別 fix）。§監視 6-4/6-5 |
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

## 単体翻訳 API（`POST /api/images/[id]/translate-prompt`, Phase 10-9C-3）

画像1件の `prompt.currentBody` を日本語訳し、`translated_body_ja` にキャッシュする。
元の英語 prompt（`current_body` / `original_body`）は絶対に上書きしない。body: `{ force?: boolean }`。

- 認証・存在・認可・レート超過のみ非 200（401 / 403 / 404 / 429）。それ以外の業務状態は
  すべて **HTTP 200 + `{ status, translation }`** で返す。`status`:
  - `disabled` — `isTranslationEnabled(env)` が false（mock 含む）。**DB / budget / provider に
    一切触れない**（`[MOCK-JA]` を DB に入れない最重要ガード）。`translation: null`。
  - `no_prompt` — prompt 未登録。`translation: null`。
  - `SKIPPED_ALREADY_JA` — 既に日本語。`translated_body_ja=current_body` として保存。
  - `DONE` — 翻訳成功（`cached:true` は既存有効訳の再利用で provider 未呼び出し）。
  - `FAILED` — provider エラー / budget 拒否 / （想定外の）config_error。`translation_error` に
    sanitize 済み文言、`translated_body_ja` は既存維持。
  - `stale` — 処理中に `current_body` が変わった。古い訳は書かない。`translation: null`。
- 順序: auth → resolveWorkspaceImage → deleted/non-ACTIVE 404 → **disabled early-return** →
  no_prompt → rate limit(`translatePrompt`) → `decideTranslationTarget` →
  （translate の時のみ）provider 解決 → config_error は FAILED 保存 →
  `reserveTranslationBudget` → provider.translate → `current_body` 一致 guard 付き updateMany。
- 入力は `TRANSLATION_MAX_INPUT_CHARS` で truncate（provider 入力のみ）。`translated_from_body_hash`
  は truncate 前のフル `current_body` の hash を保存する。
- provider の raw response / usage / token / headers / request id / API キーは
  返さない・保存しない・ログしない（訳文テキストのみ保存）。

---

## 検証環境 / Preview での疎通（10-9C-3/4 実装後）

検証環境 `.env.local`（本番と別・git に入れない）に
`TRANSLATION_ENABLED=true` / `TRANSLATION_PROVIDER=openai` / `TRANSLATION_MODEL=gpt-4o-mini` /
`OPENAI_API_KEY`（ユーザー設定）/ `TRANSLATION_DAILY_CALL_LIMIT=5` + Upstash Redis を設定し、
英語 prompt 画像で「日本語訳を追加」→ 実日本語訳が入る / `[MOCK-JA]` でない / 原文非上書き /
DB に生レスポンスが残らないこと（SQL）を確認する。

---

## Production enablement (Phase 10-9C-6)

Production で DetailPanel 日本語翻訳を**安全に有効化**するための手順・rollback・QA・監視。
main `215e23a`（Phase 10-9C-2〜5 完了、Preview QA OK）を前提とする。

> **本番 env 設定・redeploy・本番 DB 操作はすべてユーザーが実施する。** 担当エージェントは
> 本番 env / DB / Storage / Supabase / Vercel 設定に触れない。以下はユーザー向け手順書。

### 1. Production に設定する env

`isTranslationEnabled()` は **3条件すべて true** で初めて有効。1つでも欠けると mock 扱いになり、
DetailPanel に翻訳ボタンが出ない（detail API `translationEnabled=false`）。

| env | 必須 | 値 | 備考 |
|---|---|---|---|
| `TRANSLATION_ENABLED` | ✅ | `true` | 文字列 `"true"` 完全一致。killswitch（最優先） |
| `TRANSLATION_PROVIDER` | ✅ | `openai` | `"openai"` 完全一致（mock/他だと無効） |
| `TRANSLATION_MODEL` | 推奨 | `gpt-4o-mini` | **未設定時のコード上の既定も `gpt-4o-mini`**。ただし modelId・監視・運用の明確化のため Production env では**明示指定を推奨**（modelId `openai:gpt-4o-mini:tr-v2` が budget/監視キーに反映される） |
| `TRANSLATION_OPENAI_API_KEY` **または** `OPENAI_API_KEY` | ✅（どちらか） | (secret) | 前者を優先、無ければ後者に fallback。AI 解析と同じキーだと OpenAI usage が混在するため、課金を分離したい場合は翻訳専用キーを設定（任意） |
| `TRANSLATION_DAILY_CALL_LIMIT` | 推奨 | `5`（初回） | **未設定時のコード上の既定は 20**。**初回 Production 有効化では 5 から開始**し、安定後に 10 → 20 へ段階引き上げ |
| `TRANSLATION_TIMEOUT_MS` | 任意 | `60000` | コード既定 60000 |
| `TRANSLATION_MAX_INPUT_CHARS` | 任意 | `8000` | コード既定 8000。provider 入力のみ truncate（hash はフル body 基準） |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | ✅ | (既存) | cost guard の前提。**budget は fail-CLOSED**（下記§budget） |

### 2. 初期推奨値

- `TRANSLATION_DAILY_CALL_LIMIT=5` で開始（Preview QA と同値）。安定後に `10 → 20`（既定）へ段階引き上げ。
  引き上げは env 変更 + redeploy のみ（コード変更不要）。
- `TRANSLATION_MODEL=gpt-4o-mini` を明示。`TRANSLATION_TIMEOUT_MS=60000` / `TRANSLATION_MAX_INPUT_CHARS=8000` は既定のままで可。

### 3. budget 仕様（重要）

cost guard（`reserveTranslationBudget`, Redis INCR, キー
`budget:translation:<UTC-YYYY-MM-DD>:<workspaceHash>:<providerId>:<modelId>`, TTL 2日）:

- **fail-CLOSED**: Redis 未設定 or 障害時は `allowed:false`（`translation budget unavailable`）→
  **その翻訳は FAILED**。※rate limit（fail-open）とは逆。Redis が死ぬと**新規翻訳は全て失敗**する
  （ただし既存訳の**表示**は budget 非依存で継続）。
- **provider 呼び出しの前に 1 消費**する（reserve → provider.translate の順）。
- **timeout / refusal / rate limit / provider failure でも返金しない**（refund 未実装）。
  → `DAILY_CALL_LIMIT` は「1 workspace/日あたりの provider 試行回数」の上限。QA で再生成を繰り返すと消費する。
- **消費しないケース**: cache hit（有効な DONE 訳の再利用）/ 既に日本語（SKIPPED_ALREADY_JA）/
  disabled early-return。これらは provider も budget も呼ばない。
- キーは UTC 日付でローテーション。modelId を含むため model / prompt version 変更で counter namespace が分離される。

### 4. Production redeploy 手順（ユーザー実施）

1. Vercel Production 環境に §1 の env を設定（secret はダッシュボード / CLI。**git には入れない**）。
2. Production を redeploy（env 反映のため再ビルド必須）。
3. デプロイ完了後、Production URL で §5 QA を実施。

### 5. 本番 QA 手順（有効化直後・Production URL）

英語 prompt を持つ画像1件で:

1. `/gallery` → 画像を開く → DetailPanel に「日本語訳」セクション + 「日本語訳を追加」ボタンが出る（gate 成立）。
2. 「日本語訳を追加」→ **実日本語訳**が表示される。
3. `[MOCK-JA]` **でない**こと。
4. **拒否文でない**こと（refusal guard 動作。万一拒否時は訳ではなく「翻訳に失敗しました:
   translation provider refused」= FAILED になるのが正）。
5. **英語原文が上書きされていない**こと（原文セクションは英語のまま）。
6. **再生成**（「日本語訳を再生成」）1回 → 訳が更新され、loading 中は連打不可。
7. **mobile drawer** でも表示崩れなし。
8. OpenAI usage（1〜数コール）・Redis budget キー（§7-7）が想定内。

### 6. rollback 手順（即時停止）

1. `TRANSLATION_ENABLED=false` に変更（または `TRANSLATION_PROVIDER` を `openai` 以外に）。
2. Production redeploy。
3. 効果:
   - DetailPanel の**新規翻訳ボタンが消える**（`translationEnabled=false`）→ 新規翻訳 API 呼び出しが止まる。
   - route も早期 return（disabled）で **provider / budget / DB 更新導線が止まる** → OpenAI 追加課金停止。
   - **既存の有効な日本語訳（`translated_body_ja` の DONE）は DB に残り、表示も継続**（ボタンだけ消える）。
- env だけの rollback で、コード revert・schema 操作は不要。cost guard カウンタは Redis のみ（日次 TTL）。

### 7. 監視 SQL / 確認項目

> 対象テーブル `prompts`（列は snake_case）。運用者が本番 DB に **read-only SELECT** で実行（エージェントは実行しない）。
> 監視目的のため workspace 横断で可。

**7-1. status 別件数**
```sql
SELECT translation_status, COUNT(*)
FROM prompts
GROUP BY translation_status
ORDER BY 2 DESC;
```

**7-2. FAILED の error 別内訳**
```sql
SELECT translation_error, COUNT(*)
FROM prompts
WHERE translation_status = 'FAILED'
GROUP BY translation_error
ORDER BY 2 DESC;
-- 注目: 'translation provider refused'（refusal）,
--       'translation budget unavailable'（Redis fail-closed → 多発は異常）,
--       'translation daily budget exceeded'（日次上限・正常ガード）,
--       'translation provider timeout' / 'rate limited' / 'unavailable'
```

**7-3. provider / model / status 別件数**
```sql
SELECT translation_provider, translation_model, translation_status, COUNT(*)
FROM prompts
WHERE translation_provider IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
-- 期待 model: 'openai:gpt-4o-mini:tr-v2'
```

**7-4. refusal（`translation provider refused`）件数**
```sql
SELECT COUNT(*) AS refusal_failed
FROM prompts
WHERE translation_status = 'FAILED'
  AND translation_error = 'translation provider refused';
```

**7-5. DONE/SKIPPED 内に `[MOCK-JA]` や拒否文が混入していないか（NO-GO 判定に使用）**
```sql
SELECT id, workspace_id, translated_at,
       left(translated_body_ja, 60) AS ja_head
FROM prompts
WHERE translation_status IN ('DONE', 'SKIPPED_ALREADY_JA')
  AND translated_body_ja IS NOT NULL
  AND (
        translated_body_ja LIKE '[MOCK-JA]%'
     OR translated_body_ja LIKE '申し訳ございません%'
     OR translated_body_ja LIKE '申し訳ありません%'
     OR translated_body_ja LIKE 'お応えできません%'
     OR lower(translated_body_ja) LIKE 'i''m sorry%'
     OR lower(translated_body_ja) LIKE 'i am sorry%'
     OR lower(translated_body_ja) LIKE 'i cannot %'
     OR lower(translated_body_ja) LIKE 'i can''t %'
  )
ORDER BY translated_at DESC;
-- 0件が正常。1件でも出たら NO-GO（guard すり抜け or 旧データ）→ 該当画像は再生成で上書き。
```

**7-6. 直近の翻訳 prompt 確認**
```sql
SELECT id, translation_status, translation_provider, translation_model,
       translation_error, translated_at,
       left(current_body, 40)       AS en_head,
       left(translated_body_ja, 40) AS ja_head
FROM prompts
WHERE translated_at IS NOT NULL
ORDER BY translated_at DESC
LIMIT 30;
```

**7-7. Redis budget キー（Upstash コンソール）**
- キー形式: `budget:translation:<UTC-YYYY-MM-DD>:<workspaceHash>:openai:openai:gpt-4o-mini:tr-v2`
  （`workspaceHash` は workspaceId の SHA-256。生 ID は出ない。TTL 2日）
- 値（INCR カウント）が `TRANSLATION_DAILY_CALL_LIMIT` に対しどの程度か確認。UTC 日付でリセット。

**7-8. OpenAI usage** — OpenAI ダッシュボードでコール数・コスト（翻訳専用キーなら翻訳分の切り分け）を確認。

### 8. リスク

| リスク | 内容 | 緩和策 |
|---|---|---|
| OpenAI コスト | 翻訳コール増 | `DAILY_CALL_LIMIT` を低く開始。cache で重複抑制。usage 監視 |
| budget が失敗でも消費 | 返金未実装。timeout/refusal 等でも 1 消費 | limit を試行回数上限として理解。無駄な再生成を控える |
| Redis 障害で全翻訳停止（fail-CLOSED） | Redis 未設定/障害で新規翻訳が全 FAILED（`translation budget unavailable`）。既存訳の表示は継続 | 有効化前に Redis env 確認。7-2 で "unavailable" を監視 |
| refusal 再発 | 未知の拒否表現 | guard は先頭一致の既知パターン + system prompt tr-v2。7-4/7-5 監視、増えたら guard 拡充（別 fix） |
| 翻訳品質 | 意訳・欠落 | サンプル目視。不足なら model 変更（別タスク）。modelId 変更で cache/budget 自然分離 |
| 本番ユーザー表示 | 誤訳/拒否文がユーザーに見える | 7-5 を GO 前後に必ず実行。stale 訳は `effectiveTranslatedBodyJa`（server hash 照合）で非表示 |

### 9. GO / NO-GO 判断基準

**GO（有効化継続）— すべて満たす:**
- §5 本番 QA 全項目 OK。
- 7-5（mock / 拒否文混入）が **0件**。
- 7-2 の FAILED が想定範囲（refusal/timeout 散発程度）。
- `translation budget unavailable` が **なし**（= Redis 正常）。
- OpenAI usage / コストが想定内。

**NO-GO / 即時 rollback（§6）— いずれか:**
- DONE/SKIPPED に **拒否文 または `[MOCK-JA]` が 1 件でも保存**（7-5 が非0）。
- 拒否文が翻訳としてユーザーに表示された事例。
- 英語原文が翻訳で上書きされた事例。
- `translation budget unavailable` 多発（Redis 障害 = fail-closed で機能不全）。
- OpenAI usage / コストが異常増。

**停止後の再開:** 原因（refusal パターン / Redis / コスト）を別 feature ブランチで修正 →
Preview 再 QA → main merge → 本番 env 再有効化。**本番 DB 直接編集はせず、既存不良データは再生成で上書き。**

### 10. 含めない / 触らない

- 本番 env 設定・redeploy・本番 DB 操作（ユーザーのみ）
- translate-batch（mock 固定のまま）/ provider 基盤改修 / schema / migration
- コード変更・commit（本節は docs-only）
