import { NextResponse } from "next/server";
import { Client } from "pg";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function parseDatabaseUrl(raw: string | undefined) {
  if (!raw) return { exists: false };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return {
      exists: true,
      length: raw.length,
      trimmedLength: raw.trim().length,
      parseError: e instanceof Error ? e.message : String(e),
    };
  }

  return {
    exists: true,
    length: raw.length,
    trimmedLength: raw.trim().length,
    hasLeadingOrTrailingWhitespace: raw !== raw.trim(),
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || null,
    databaseName: parsed.pathname.replace(/^\//, "") || null,
    hasUsername: !!parsed.username,
    hasPassword: !!parsed.password,
    queryKeys: [...parsed.searchParams.keys()],
    parseError: null,
  };
}

async function testPgDirect(connectionString: string) {
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    const result = await client.query(
      "SELECT current_database() AS database, current_user AS db_user, inet_server_port() AS server_port"
    );
    await client.end();

    const row = result.rows[0];
    return {
      ok: true,
      result: {
        database: row?.database ?? null,
        serverPort: row?.server_port ?? null,
      },
    };
  } catch (err) {
    try { await client.end(); } catch { /* ignore */ }
    const e = err as NodeJS.ErrnoException & { address?: string; port?: number };
    return {
      ok: false,
      error: {
        name: e.name ?? null,
        message: e.message ?? null,
        code: e.code ?? null,
        errno: e.errno ?? null,
        syscall: e.syscall ?? null,
        address: e.address ?? null,
        port: e.port ?? null,
      },
    };
  }
}

async function testPrismaRaw() {
  try {
    await prisma.$queryRaw`SELECT 1 AS ok`;
    return { ok: true };
  } catch (err) {
    const e = err as { name?: string; message?: string; code?: string; clientVersion?: string };
    return {
      ok: false,
      error: {
        name: e.name ?? null,
        message: e.message ?? null,
        code: e.code ?? null,
        clientVersion: e.clientVersion ?? null,
      },
    };
  }
}

async function testWorkspaceMember() {
  try {
    const record = await prisma.workspaceMember.findFirst({
      select: { userId: true, workspaceId: true, role: true },
    });
    return {
      ok: true,
      hasRecord: record !== null,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string; code?: string; clientVersion?: string };
    return {
      ok: false,
      error: {
        name: e.name ?? null,
        message: e.message ?? null,
        code: e.code ?? null,
        clientVersion: e.clientVersion ?? null,
      },
    };
  }
}

export async function GET() {
  if (process.env.ENABLE_RUNTIME_DB_CONNECT_CHECK !== "true") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rawUrl = process.env.DATABASE_URL;
  const databaseUrl = parseDatabaseUrl(rawUrl);

  const runtime = {
    nodeEnv: process.env.NODE_ENV ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    vercelRegion: process.env.VERCEL_REGION ?? null,
  };

  const pgDirect = rawUrl
    ? await testPgDirect(rawUrl)
    : { ok: false, error: { message: "DATABASE_URL is not set" } };

  const prismaRaw = await testPrismaRaw();
  const workspaceMember = await testWorkspaceMember();

  const allOk = pgDirect.ok && prismaRaw.ok && workspaceMember.ok;

  return NextResponse.json({
    ok: allOk,
    runtime,
    databaseUrl,
    pgDirect,
    prismaRaw,
    workspaceMember,
  });
}
