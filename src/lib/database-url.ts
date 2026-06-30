type DatabaseUrlDiagnostics = {
  exists: boolean;
  length: number;
  trimmedLength: number;
  hasLeadingOrTrailingWhitespace: boolean;
  startsWithPostgresScheme: boolean;
  protocol: string | null;
  hostname: string | null;
  port: string | null;
  databaseName: string | null;
  hasUsername: boolean;
  hasPassword: boolean;
  queryKeys: string[];
  parseError: string | null;
  pgEnvironment: {
    PGHOST: { present: boolean; value: string | null };
    PGPORT: { present: boolean };
    PGDATABASE: { present: boolean };
    PGUSER: { present: boolean };
    PGPASSWORD: { present: boolean };
  };
};

export function getDatabaseUrlDiagnostics(): DatabaseUrlDiagnostics {
  const raw = process.env.DATABASE_URL;
  const exists = typeof raw === "string";
  const value = raw ?? "";
  const trimmed = value.trim();

  const base = {
    exists,
    length: value.length,
    trimmedLength: trimmed.length,
    hasLeadingOrTrailingWhitespace: value !== trimmed,
    startsWithPostgresScheme: /^postgres(?:ql)?:\/\//.test(trimmed),
    protocol: null,
    hostname: null,
    port: null,
    databaseName: null,
    hasUsername: false,
    hasPassword: false,
    queryKeys: [] as string[],
    parseError: null,
    pgEnvironment: {
      PGHOST: {
        present: typeof process.env.PGHOST === "string",
        value: process.env.PGHOST ?? null,
      },
      PGPORT: { present: typeof process.env.PGPORT === "string" },
      PGDATABASE: { present: typeof process.env.PGDATABASE === "string" },
      PGUSER: { present: typeof process.env.PGUSER === "string" },
      PGPASSWORD: { present: typeof process.env.PGPASSWORD === "string" },
    },
  };

  if (!trimmed) return base;

  try {
    const parsed = new URL(trimmed);
    return {
      ...base,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || null,
      databaseName: parsed.pathname.replace(/^\//, "") || null,
      hasUsername: parsed.username.length > 0,
      hasPassword: parsed.password.length > 0,
      queryKeys: Array.from(parsed.searchParams.keys()).sort(),
    };
  } catch (error) {
    return {
      ...base,
      parseError: error instanceof Error ? error.message : "Unknown DATABASE_URL parse error",
    };
  }
}

export function getDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  const value = raw?.trim();

  if (!value) {
    throw new Error("DATABASE_URL is missing or empty at runtime.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown parse error";
    throw new Error(`DATABASE_URL is not a valid URL at runtime: ${message}`);
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(`DATABASE_URL must use postgres/postgresql protocol, got ${parsed.protocol || "empty"}.`);
  }

  if (!parsed.hostname) {
    throw new Error("DATABASE_URL hostname is missing at runtime.");
  }

  return value;
}
