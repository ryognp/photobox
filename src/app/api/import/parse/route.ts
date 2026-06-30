import "server-only";

// xlsx / dns lookup が必要なため Node.js Runtime を明示
export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { getCurrentUser, getDefaultWorkspaceForUser } from "@/lib/auth";
import { ok, Errors } from "@/lib/apiResponse";
import { parseImportFile } from "@/lib/import/parseFile";

const FILE_SIZE_LIMIT = 4 * 1024 * 1024; // 4 MB

const ALLOWED_MIME = new Set([
  "text/csv",
  "application/csv",
  "text/plain", // some OS sends .csv as text/plain
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return Errors.unauthorized();

  const workspace = await getDefaultWorkspaceForUser(user.id);
  if (!workspace) return Errors.forbidden();

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Errors.validation("Invalid multipart form data");
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return Errors.validation("file is required");
  }

  // サイズチェック
  if (file.size > FILE_SIZE_LIMIT) {
    return Errors.validation(
      `ファイルサイズが上限 (4MB) を超えています (${(file.size / 1024 / 1024).toFixed(1)} MB)`
    );
  }

  // MIME チェック（拡張子フォールバックあり）
  const ext = file.name.split(".").pop()?.toLowerCase();
  const mime = file.type || "";
  const isAllowedMime = ALLOWED_MIME.has(mime) || ext === "csv" || ext === "xlsx";
  if (!isAllowedMime) {
    return Errors.validation(
      "CSV (.csv) または XLSX (.xlsx) ファイルのみ対応しています"
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = parseImportFile(buffer, file.name, file.type);
    return ok(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    if (msg === "DATA_EMPTY") {
      return Errors.validation("データ行が見つかりません。ヘッダー行と1行以上のデータが必要です");
    }
    if (msg.startsWith("ROW_LIMIT:")) {
      const count = msg.split(":")[1];
      return Errors.validation(
        `データ行が多すぎます (${count} 行)。100行以内にしてください`
      );
    }

    return Errors.internal();
  }
}
