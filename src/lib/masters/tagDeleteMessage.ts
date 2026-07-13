// Pure confirm-message formatting for Tag master force-delete (Phase 10-20B).
// No DOM/React import — unit-testable. Used by the /masters Tags tab when a
// Tag with imageCount > 0 is force-deleted (unlinking ImageTag/UploadItemTag
// rows via the Tag's cascade, without touching Image rows themselves).

/** e.g. `「海」を画像から完全に外して削除します。10枚の画像からこのタグの
 *  紐づけが解除されます（画像自体は削除されません）。元に戻せません。` */
export function formatTagForceDeleteConfirmMessage(tagName: string, imageCount: number): string {
  return `「${tagName}」を画像から完全に外して削除します。${imageCount}枚の画像からこのタグの紐づけが解除されます（画像自体は削除されません）。元に戻せません。`;
}
