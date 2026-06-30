import "server-only";

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getDatabaseUrlDiagnostics } from "@/lib/database-url";

function diagnosticsEnabled() {
  return process.env.ENABLE_RUNTIME_DB_CHECK === "true" || process.env.ENABLE_DEV_API_CHECK === "true";
}

export async function GET() {
  if (!diagnosticsEnabled()) {
    return NextResponse.json({ ok: false, error: "Not Found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    runtime: {
      nodeEnv: process.env.NODE_ENV ?? null,
      vercelEnv: process.env.VERCEL_ENV ?? null,
      vercelRegion: process.env.VERCEL_REGION ?? null,
    },
    databaseUrl: getDatabaseUrlDiagnostics(),
  });
}
