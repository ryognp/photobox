import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// createClient() をビルド時ではなく初回アクセス時に遅延実行する。
// Vercel build 時は SUPABASE_SERVICE_ROLE_KEY が未定義のため、
// モジュール最上位で createClient() を呼ぶと "supabaseKey is required" エラーになる。
let _client: SupabaseClient | undefined;

function getInstance(): SupabaseClient {
  return (_client ??= createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  ));
}

export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    const value = Reflect.get(getInstance(), prop);
    return typeof value === "function" ? value.bind(getInstance()) : value;
  },
});
