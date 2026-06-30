import "server-only";

import { createHash } from "node:crypto";

export function sha256Hex(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}
