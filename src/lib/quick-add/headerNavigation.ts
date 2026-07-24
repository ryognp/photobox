// Quick Add ヘッダーの Gallery/Masters/Import リンクが、クリック/Enter活性化を
// どう扱うべきかを判定する。イベントの実際の型(MouseEvent等)には依存しない、
// 判定に必要な情報だけを受け取る純粋関数にすることでテスト容易にしている。

export type NavigationActivation = "guard" | "bypass" | "block" | "ignore";

export type NavigationEventInfo = {
  // 呼び出し側で既に preventDefault 済みなら、二重処理を避けるため何もしない。
  defaultPrevented: boolean;
  // MouseEvent.button: 0 = primary(通常は左クリック)、1 = auxiliary(通常は中クリック)、
  // 2 = secondary(通常は右クリック)、3/4 = 戻る/進むボタン等。
  // キーボードEnterによる合成clickは通常 0 になる。
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

// - guard:  button=0・修飾キーなしの通常クリック/Enter活性化(保存中でない)。
//           呼び出し側は preventDefault した上で requestTransition 等の
//           遷移ガードへ委譲する。
// - bypass: button=1(中クリック)、または button=0 の修飾キー付きクリックで、
//           かつ保存中でない場合。新しいタブ/ウィンドウを意図する操作として
//           ブラウザ標準動作に任せる(preventDefaultしない)。
// - block:  guard/bypass に該当する button(0または1)の操作が、保存中に
//           行われた場合。preventDefault して何もしない(遷移もタブも開かせない)。
// - ignore: 右クリック(button=2)・戻る/進むボタン(button=3/4)・負値などの
//           対象外button、または既に defaultPrevented 済みのイベント。
//           Quick Add 独自の遷移処理では一切扱わず、preventDefaultしない・
//           onNavigateを呼ばない — ブラウザ/OSの標準動作(右クリックメニュー・
//           リンクURLコピー等)へそのまま委譲する。
export function classifyNavigationActivation(
  info: NavigationEventInfo,
  isSaving: boolean,
): NavigationActivation {
  if (info.defaultPrevented) return "ignore";
  if (info.button !== 0 && info.button !== 1) return "ignore";

  if (isSaving) return "block";

  const isNewTabIntent =
    info.button === 1 || info.metaKey || info.ctrlKey || info.shiftKey || info.altKey;

  return isNewTabIntent ? "bypass" : "guard";
}
