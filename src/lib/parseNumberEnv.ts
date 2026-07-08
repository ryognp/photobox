// Parses a positive-integer environment variable, falling back to `fallback`
// for undefined / blank / non-numeric / NaN / <= 0 values. Truncates floats.
// Kept generic (not analysis-specific) so other config readers can reuse it.
export function parseNumberEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}
