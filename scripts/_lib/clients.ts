import { config as dotenvConfig } from "dotenv";
import path from "node:path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";

export function loadEnv(): void {
  dotenvConfig({ path: path.resolve(process.cwd(), ".env") });
  dotenvConfig({ path: path.resolve(process.cwd(), ".env.local"), override: true });
}

export function createSupabaseAdmin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE env vars");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export function createPrisma(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}
