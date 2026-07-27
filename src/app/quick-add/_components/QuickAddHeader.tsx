"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { classifyNavigationActivation } from "@/lib/quick-add/headerNavigation";

type Props = {
  workspaceName: string;
  userEmail: string;
  itemCount: number;
  sessionId: string | null;
  // Phase 10-41-B: 保存中はGallery/Masters/Importでの離脱をブロックする表示に使う。
  // dirty判定そのものはQuickAddClient側(requestTransition)が正本であり、ここには渡さない。
  isSaving: boolean;
  // Gallery/Masters/Import共通の遷移窓口。QuickAddClient側でrequestTransition()経由の
  // router.pushへ委譲される。hrefごとに個別のcallback/判定ロジックは持たない。
  onNavigate: (href: string) => void;
};

const NAV_LINKS = [
  { href: "/gallery", label: "Gallery" },
  { href: "/masters", label: "Masters" },
  { href: "/import", label: "Import" },
] as const;

export default function QuickAddHeader({ workspaceName, userEmail, itemCount, sessionId, isSaving, onNavigate }: Props) {
  // 通常クリック/Enter(guard) → preventDefaultしてonNavigateへ委譲(defaultとrouter.pushが
  // 両方走らないよう1回だけ遷移させる)。修飾キー/中クリック(bypass) → ブラウザ標準動作に
  // 任せる(preventDefaultしない)。保存中(block) → preventDefaultして何もしない。
  // 右クリック(button=2)・戻る/進むボタン・defaultPrevented済み(ignore)は
  // Quick Add側では一切処理しない — preventDefaultせず、onNavigateも呼ばず、
  // ブラウザ標準のコンテキストメニュー/リンクURLコピー等にそのまま委譲する。
  function handleActivate(e: MouseEvent<HTMLAnchorElement>, href: string) {
    const activation = classifyNavigationActivation(
      {
        defaultPrevented: e.defaultPrevented,
        button: e.button,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      },
      isSaving,
    );

    if (activation === "guard") {
      e.preventDefault();
      onNavigate(href);
      return;
    }
    if (activation === "block") {
      e.preventDefault();
      return;
    }
    if (activation === "bypass") {
      // 新規タブ等のブラウザ標準動作に任せる(preventDefaultしない)
      return;
    }
    // ignore: 右クリック等の対象外操作、または既にdefaultPrevented済み。
    // 何もしない — ブラウザ/OSの標準動作(コンテキストメニュー等)に完全に委ねる。
  }

  return (
    <header className="flex items-center gap-4 border-b border-zinc-200 bg-white px-4 py-3">
      <span className="text-lg font-bold text-zinc-900">Photobox</span>
      <span className="text-zinc-300">|</span>
      <span className="text-sm font-medium text-zinc-700">{workspaceName}</span>
      {NAV_LINKS.map(({ href, label }) => (
        <Link
          key={href}
          href={href}
          onClick={(e) => handleActivate(e, href)}
          onAuxClick={(e) => handleActivate(e, href)}
          aria-disabled={isSaving || undefined}
          className={[
            "text-sm text-zinc-500 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1",
            isSaving ? "cursor-not-allowed opacity-50" : "",
          ].join(" ")}
        >
          {label}
        </Link>
      ))}
      <span className="ml-auto flex items-center gap-4 text-xs text-zinc-500">
        {sessionId && (
          <span className="font-mono">
            session: {sessionId.slice(0, 8)}
          </span>
        )}
        <span>{itemCount} items</span>
        <span>{userEmail}</span>
      </span>
    </header>
  );
}
