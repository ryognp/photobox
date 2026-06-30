# Photobox

画像・プロンプト管理アプリ。設計詳細は `../DESIGN_v1.2.md` を参照。

---

## セットアップ

### 1. 環境変数を設定する

```bash
cp .env.example .env.local
```

`.env.local` を開き、以下を Supabase Dashboard から取得して入力:

| 変数 | 取得場所 |
|---|---|
| `DATABASE_URL` | Project Settings > Database > Connection string > Transaction (Port 6543) |
| `DIRECT_URL` | Project Settings > Database > Connection string > Session (Port 5432) |
| `NEXT_PUBLIC_SUPABASE_URL` | Project Settings > API > Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project Settings > API > anon public |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings > API > service_role (**サーバー側のみ**) |

### 2. Supabase Storage bucket を作成する

Supabase Dashboard > Storage > New bucket:

- Bucket name: `photobox-private`
- Public bucket: **OFF**（必ず private）
- Allowed MIME types: `image/jpeg, image/png, image/webp`
- Max upload size: `20 MB`

### 3. DB マイグレーションを実行する

`migrate dev` は **Direct Connection URL（Port 5432）** が必要です:

```bash
cp .env.migrate.example .env.migrate
# .env.migrate の DATABASE_URL に Port 5432 の URL を入力
npm run db:migrate
# Migration name を聞かれたら: init
```

### 4. RLS ポリシーを設定する

Supabase Dashboard > SQL Editor で `docs/rls-policies.sql` を実行してください。

### 5. 開発サーバーを起動する

```bash
npm run dev
```

---

## npm scripts

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー起動 |
| `npm run build` | プロダクションビルド |
| `npm run db:validate` | schema.prisma の検証 |
| `npm run db:migrate` | migrate dev（.env.migrate が必要） |
| `npm run db:migrate:prod` | migrate deploy（本番用） |
| `npm run db:generate` | Prisma Client 生成 |
| `npm run db:studio` | Prisma Studio 起動 |

---

## アーキテクチャ概要

- **Storage**: `photobox-private` 1 bucket（全 private、client direct access 禁止）
- **画像アクセス**: signed URL のみ（`/api/storage/signed-url(s)` 経由）
- **アップロード**: API Route が multipart 受信 → service role で Storage PUT
- **Commit**: 冪等。`reservedImageId` でリトライ時も同一 ID を再利用
- **認証**: Supabase Auth + `workspace_members` での API 層認可 + RLS（防御層）

詳細は `../DESIGN_v1.2.md` を参照。

---

## Getting Started (original)

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
