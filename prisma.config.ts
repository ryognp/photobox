import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7 の datasource.url は単一 URL のみ。
// prisma migrate dev は DIRECT_URL（Direct Connection）で実行する必要がある。
// 通常実行は pgbouncer=true の Transaction Pooler URL を使う。
//
// migrate 実行方法:
//   DATABASE_URL=$DIRECT_URL npx prisma migrate dev --name <name>
// または .env.migrate を用意して:
//   dotenv -e .env.migrate -- npx prisma migrate dev --name <name>
const url = process.env["DATABASE_URL"]!;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url,
  },
});
