// Prisma enums の re-export（value + type を一括）
export * from "../generated/prisma/enums";

// API レスポンスの共通型
export type ApiError = { error: string };

// workspace 権限
export type WorkspaceRole = "owner" | "member";
