# トラブルシューティング

よくあるエラー・症状と対応方法。

---

## 一覧表

| # | 症状 | 原因候補 | 確認コマンド / 確認場所 | 対応方法 | 関連ドキュメント |
|---|---|---|---|---|---|
| 1 | localhost:3007 が開けない | dev server が起動していない | ターミナルで `npm run dev` が動いているか確認 | `npm run dev` を実行 | [OPERATIONS.md](OPERATIONS.md) |
| 2 | EADDRINUSE: port 3007 | 別プロセスが 3007 を占有している | `lsof -i :3007` | `lsof -ti :3007 \| xargs kill -9` → `npm run dev` | [OPERATIONS.md](OPERATIONS.md) |
| 3 | Turbopack Failed to open database | Turbopack が有効になっている | `package.json` の `dev` script を確認 | `--turbo` フラグを外す（現在は `--webpack` で起動済み） | [README.md](../README.md) |
| 4 | Invalid Compact JWS | `SUPABASE_SERVICE_ROLE_KEY` が古い形式 | Supabase Dashboard → Settings → API | Supabase Dashboard で service_role key を **Regenerate** | [README.md](../README.md) |
| 5 | /gallery が開けない（ページが白い） | dev server 停止 / ログイン切れ | ブラウザの Network タブで status code 確認 | 401 → ログイン、500 → dev server ログ確認 | [OPERATIONS.md](OPERATIONS.md) |
| 6 | /api/images が 500 | DB 接続エラー / service_role key 不正 | ターミナルの dev server ログ | `DATABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` を `.env.local` で確認 | [OPERATIONS.md](OPERATIONS.md) |
| 7 | Storage signed URL error | service_role key 不正 / bucket 名違い | Supabase Dashboard → Storage | `SUPABASE_SERVICE_ROLE_KEY` を確認。bucket 名が `photobox-private` か確認 | [OPERATIONS.md](OPERATIONS.md) |
| 8 | ImportBatch が PROCESSING で止まる | import スクリプトが途中で終了した | Prisma Studio → `import_batches` テーブル | 下記 SQL で FAILED に変更 → `cleanup:import-batch` で削除 → 再 import | [OPERATIONS.md](OPERATIONS.md) |
| 9 | ImportBatch が FAILED | import 中にエラーが発生 | `SELECT error_log FROM import_batches WHERE id = '<id>'` | error_log を確認 → 重複なら `repair:import-duplicates` → 不要なら `cleanup:import-batch` | [XLSX_IMPORT_RUNBOOK.md](XLSX_IMPORT_RUNBOOK.md) |
| 10 | Storage orphan が出る | import 中断 / cleanup 後の残骸 | `npm run audit:storage-assets -- --workspace-id <id>` | 内容を確認して `--cleanup-orphans` で削除 | [SCRIPTS.md](SCRIPTS.md) |
| 11 | Storage missing files が出る | DB にパスがあるが Storage にファイルがない | `npm run audit:storage-assets -- --workspace-id <id>` | XLSX 原本から `cleanup:import-batch` → 再 import | [XLSX_IMPORT_RUNBOOK.md](XLSX_IMPORT_RUNBOOK.md) |
| 12 | `._*` ファイルが xlsx フォルダにある | macOS が自動生成するメタデータファイル | `ls -la /Volumes/Extreme\ SSD/photobox/xlsx/` | extract スクリプトは自動スキップ。git も `.gitignore` の `._*` でカバー済み | [README.md](../README.md) |
| 13 | XLSX extract が遅い / 止まる | 画像枚数が多い XLSX を処理中 | ターミナルの進捗ログを確認 | 正常動作。数百枚 XLSX は数分かかる場合がある | [XLSX_IMPORT_RUNBOOK.md](XLSX_IMPORT_RUNBOOK.md) |
| 14 | sharp error（画像処理エラー） | sharp ライブラリが未インストール / 破損 | `npm list sharp` | `npm install` を再実行。それでも失敗する場合は `npm rebuild sharp` | — |
| 15 | Prisma P2002（Unique constraint failed） | 同一ファイルを別 batch で再 import した | Prisma Studio → import_batches の error_log | `repair:import-duplicates` で重複エラーを `duplicate skip` に再分類 | [SCRIPTS.md](SCRIPTS.md) |
| 16 | prompt_versions が増えすぎる | Quick Add で同じ画像のプロンプトを何度も変更している | `SELECT COUNT(*) FROM prompt_versions` | 現時点では削除機能なし。後続フェーズで対応予定 | [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) |
| 17 | Gallery が重い / 表示が遅い | 628件の初回ロード中 | ブラウザ Network タブで `/api/images` のレスポンス時間 | 正常動作。初回は数秒かかる場合がある。FilterSidebar でフィルタをかけると軽くなる | — |
| 18 | フィルタが効かない / リセットされる | URL パラメータの双方向同期が未実装 | ブラウザの URL バー | ページをリロードするとフィルタがリセットされる。後続フェーズで改善予定 | [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) |

---

## ImportBatch が PROCESSING で止まっている場合の SQL

```sql
-- Prisma Studio または Supabase SQL Editor で実行

-- 1. PROCESSING の batch を確認
SELECT id, xlsx_file_name, status, created_at
FROM import_batches
WHERE status = 'PROCESSING';

-- 2. FAILED に変更（<import_batch_id> を実際の ID に置き換える）
UPDATE import_batches
SET status = 'FAILED',
    error_log = 'Manual: stuck PROCESSING'
WHERE id = '<import_batch_id>';
```

その後:

```bash
# 不完全データを削除（dry-run で確認してから）
npm run cleanup:import-batch -- \
  --import-batch-id <import_batch_id> \
  --dry-run

npm run cleanup:import-batch -- \
  --import-batch-id <import_batch_id> \
  --yes
```

---

## よく使う確認 SQL

```sql
-- images 総数
SELECT COUNT(*) FROM images
WHERE deleted_at IS NULL AND status = 'ACTIVE';

-- import_batches のステータス別件数
SELECT status, COUNT(*), SUM(error_count)
FROM import_batches
GROUP BY status;

-- FAILED batch の error_log 確認
SELECT id, xlsx_file_name, error_log
FROM import_batches
WHERE status = 'FAILED'
ORDER BY created_at DESC;

-- 未コミット Upload Session（3日以上前）
SELECT COUNT(*) FROM upload_sessions
WHERE status NOT IN ('COMMITTED')
  AND created_at < NOW() - INTERVAL '3 days';
```

---

## それでも解決しない場合

1. dev server のターミナルログ全文を確認する
2. ブラウザの DevTools → Console / Network タブを確認する
3. Supabase Dashboard でプロジェクトが起動中（緑ランプ）か確認する
4. `.env.local` の各値が最新であるか Supabase Dashboard で再確認する
5. [OPERATIONS.md](OPERATIONS.md) の「トラブル時の初動」セクションを参照する
