// The context menu of an article (a list row, a Reader tab, a saved Page tab). Several picked rows
// get only what applies to all of them at once.
import type { ArticleRow } from "../api";
import type { MenuItem } from "../ui/Popover";
import type { T } from "../i18n";

export interface ArticleActions {
  favorite: (ids: number[], on: boolean) => void;
  read: (ids: number[], read: boolean) => void;
  /** Opens the group picker for these articles. */
  group: (ids: number[]) => void;
  openNew: (a: ArticleRow) => void;
  /** Absent where there is no new window to open (a pop-out's tab goes back with the strip's button). */
  popOut?: (a: ArticleRow) => void;
  page: (a: ArticleRow) => void;
  copyUrl: (a: ArticleRow) => void;
  /** Asks for confirmation first. */
  remove: (a: ArticleRow) => void;
}

export function articleMenu(rows: ArticleRow[], act: ArticleActions, t: T): (MenuItem | string)[] {
  const ids = rows.map((a) => a.id);
  const favorite = rows.every((a) => a.favorite);
  const read = rows.every((a) => a.read_status === "read");
  const one = rows.length === 1 ? rows[0] : null;
  // Imported files (local:…) have no page and no URL to share.
  const local = one?.original_url.startsWith("local:") ?? false;
  return [
    ...(one ? [] : [t("articleMenu.picked", { n: rows.length })]),
    { label: favorite ? t("articleMenu.unfavorite") : t("articleMenu.favorite"), onSelect: () => act.favorite(ids, !favorite) },
    { label: read ? t("reader.markUnread") : t("reader.markRead"), onSelect: () => act.read(ids, !read) },
    { label: t("articleMenu.addToGroup"), onSelect: () => act.group(ids) },
    ...(one
      ? [
          "-",
          { label: t("articleMenu.openNewTab"), onSelect: () => act.openNew(one) },
          ...(act.popOut ? [{ label: t("tabStrip.popOut"), onSelect: () => act.popOut!(one) }] : []),
          { label: t("articleMenu.openPage"), onSelect: () => act.page(one), disabled: local },
          { label: t("articleMenu.copyUrl"), onSelect: () => act.copyUrl(one), disabled: local },
          "-",
          { label: t("browserView.remove"), onSelect: () => act.remove(one), danger: true },
        ]
      : []),
  ];
}
