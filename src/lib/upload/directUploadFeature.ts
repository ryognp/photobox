import "server-only";

// Phase 10-43-B2 fix: fail-closed gate for the not-yet-connected Direct Upload
// prepare API. `isDirectUploadEnabled` only compares a string — no trim, no
// case-folding, no truthy coercion — so a partially-set env var never
// accidentally enables the feature. Only `readDirectUploadEnabledFlag` reads
// `process.env`, and only at call time (never fixed at module import), so a
// route always observes the current value.

export function isDirectUploadEnabled(rawValue?: string): boolean {
  return rawValue === "true";
}

export function readDirectUploadEnabledFlag(): boolean {
  return isDirectUploadEnabled(process.env.UPLOAD_DIRECT_ENABLED);
}
