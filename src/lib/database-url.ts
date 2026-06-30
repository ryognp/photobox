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
    throw new Error(
      `DATABASE_URL must use postgres/postgresql protocol, got ${parsed.protocol || "empty"}.`
    );
  }

  if (!parsed.hostname) {
    throw new Error("DATABASE_URL hostname is missing at runtime.");
  }

  return value;
}
