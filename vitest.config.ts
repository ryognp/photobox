import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 外付けSSD上の macOS AppleDouble ファイル (._*) を除外
    exclude: ["**/node_modules/**", "**/.next/**", "**/._*"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
