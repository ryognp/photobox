import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Phase 10-43-B4 P0-C3R（Frozen Plan §79-8）
  //
  // sharp の native binding（@img/sharp-linux-x64/lib/*.node）は Turbopack の
  // output file tracing が拾うが、その binding が dlopen する共有 library
  // （@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.*）は拾われず、Function
  // 実行時に ERR_DLOPEN_FAILED になる（Preview で実測）。finalize route に
  // 限定して明示 include する。
  //
  // global "/*" key は不採用（native asset が全 route へ拡散し、traced files が
  // 約 2 倍になることを実測済み）。
  outputFileTracingIncludes: {
    "/api/uploads/items/finalize": [
      "node_modules/sharp/**/*",
      "node_modules/@img/sharp-linux-x64/**/*",
      "node_modules/@img/sharp-libvips-linux-x64/**/*",
    ],
  },
};

export default nextConfig;
