// Quick Add 画像アップロードのサイズ上限。client (QuickAddClient.tsx) と
// server (api/uploads/items/route.ts) の双方から参照し、値のズレを防ぐ。
export const MAX_ORIGINAL_BYTES = 5 * 1024 * 1024; // 5MB — ユーザーが選ぶ元画像の上限
export const MAX_TOTAL_BYTES = MAX_ORIGINAL_BYTES + 2 * 1024 * 1024; // 5MB + thumbnail/preview 分の余白
export const MAX_ORIGINAL_MB = MAX_ORIGINAL_BYTES / 1024 / 1024;
