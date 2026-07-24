// Quick Add ヘッダーの Gallery/Masters/Import リンクが、クリック/Enter活性化を
// どう扱うべきかを判定する。イベントの実際の型(MouseEvent等)には依存しない、
// 判定に必要な情報だけを受け取る純粋関数にすることでテスト容易にしている。

export type NavigationActivation = "guard" | "bypass" | "block";

export type NavigationEventInfo = {
  // 呼び出し側で既に preventDefault 済みなら、二重処理を避けるため何もしない。
  defaultPrevented: boolean;
  // MouseEvent.button: 0 = 主ボタン(左クリック)、1 = 中クリック。
  // キーボードEnterによる合成clickは通常 0 になる。
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

// - guard:  通常の同一タブ操作(主ボタンクリック/Enter)。呼び出し側は
//           preventDefault した上で requestTransition 等の遷移ガードへ委譲する。
// - bypass: 新しいタブ/ウィンドウを意図する操作(修飾キー付きクリック/中クリック)。
//           保存中でなければブラウザ標準動作に任せる(preventDefaultしない)。
//           既に defaultPrevented 済みのイベントもここに含め、何もしない。
// - block:  保存中に guard/bypass に該当する操作が行われた場合。
//           呼び出し側は preventDefault して何もしない(遷移もタブも開かせない)。
export function classifyNavigationActivation(
  info: NavigationEventInfo,
  isSaving: boolean,
): NavigationActivation {
  if (info.defaultPrevented) return "bypass";

  const isNewTabIntent =
    info.button === 1 || info.metaKey || info.ctrlKey || info.shiftKey || info.altKey;

  if (isSaving) return "block";
  return isNewTabIntent ? "bypass" : "guard";
}
