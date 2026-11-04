// The context menu of an article (a list row, a Reader tab, a saved Page tab). Several picked rows
// get only what applies to all of them at once.
import type { ArticleRow } from "../api";
import type { MenuItem } from "../ui/Popover";
import type { T } from "../i18n";
import { DIFFICULTY_LABELS, RELEVANCE_LABELS } from "./library.ts";

export interface ArticleActions {
  favorite: (ids: number[], on: boolean) => void;
  read: (ids: number[], read: boolean) => void;
  /** Opens the group picker for these articles. */
  group: (ids: number[]) => void;
  /** Opens the tag picker for these articles. */
  tags: (ids: number[]) => void;
  /** `null` goes back to the AI rating. */
  relevance: (ids: number[], score: number | null) => void;
  /** `null` goes back to auto classification. */
  difficulty: (ids: number[], level: number | null) => void;
  /** "" is 未分類. */
  genre: (ids: number[], name: string) => void;
  /** The genres to offer. */
  genres: string[];
  openNew: (a: ArticleRow) => void;
  /** Absent where there is no new window to open (a pop-out's tab goes back with the strip's button). */
  popOut?: (a: ArticleRow) => void;
  page: (a: ArticleRow) => void;
  copyUrl: (a: ArticleRow) => void;
  /** Asks for confirmation first. */
  remove: (a: ArticleRow) => void;
}

/** A choice is checked when every article has it, so a mixed selection checks none. */
const all = (rows: ArticleRow[], has: (a: ArticleRow) => boolean) => rows.every(has);

export function articleMenu(rows: ArticleRow[], act: ArticleActions, t: T): (MenuItem | string)[] {
  const ids = rows.map((a) => a.id);
  const favorite = rows.every((a) => a.favorite);
  const read = rows.every((a) => a.read_status === "read");
  const one = rows.length === 1 ? rows[0] : null;
  // Imported files (local:…) have no URL to share, and only a PDF has an original to show as its page.
  const local = one?.original_url.startsWith("local:") ?? false;
  const relevance: (MenuItem | string)[] = [
    {
      label: one ? t("reader.relevanceAuto", { x: one.relevance_ai ?? t("library.relevanceNone") }) : t("articleMenu.relevanceAuto"),
      checked: all(rows, (a) => !a.relevance_manual),
      onSelect: () => act.relevance(ids, null),
    },
    "-",
    ...RELEVANCE_LABELS.map((l, i) => ({
      label: `${i + 1} ${t(l)}`,
      checked: all(rows, (a) => a.relevance_manual && a.relevance === i + 1),
      onSelect: () => act.relevance(ids, i + 1),
    })),
  ];
  const difficulty: MenuItem[] = [
    { label: t("library.difficultyNone"), checked: all(rows, (a) => a.difficulty == null), onSelect: () => act.difficulty(ids, null) },
    ...DIFFICULTY_LABELS.map((l, i) => ({
      label: `${i + 1} ${t(l)}`,
      checked: all(rows, (a) => a.difficulty === i + 1),
      onSelect: () => act.difficulty(ids, i + 1),
    })),
  ];
  const genre: (MenuItem | string)[] = [
    { label: t("common.unclassified"), checked: all(rows, (a) => a.genre == null), onSelect: () => act.genre(ids, "") },
    ...(act.genres.length ? ["-"] : []),
    ...act.genres.map((g) => ({ label: g, checked: all(rows, (a) => a.genre === g), onSelect: () => act.genre(ids, g) })),
  ];
  return [
    ...(one ? [] : [t("articleMenu.picked", { n: rows.length })]),
    { label: favorite ? t("articleMenu.unfavorite") : t("articleMenu.favorite"), onSelect: () => act.favorite(ids, !favorite) },
    { label: read ? t("reader.markUnread") : t("reader.markRead"), onSelect: () => act.read(ids, !read) },
    { label: t("articleMenu.addToGroup"), onSelect: () => act.group(ids) },
    { label: t("articleMenu.editTags"), onSelect: () => act.tags(ids) },
    "-",
    { label: t("common.relevance"), onSelect: () => {}, items: relevance },
    { label: t("common.difficulty"), onSelect: () => {}, items: difficulty },
    { label: t("common.genre"), onSelect: () => {}, items: genre },
    ...(one
      ? [
          "-",
          { label: t("articleMenu.openNewTab"), onSelect: () => act.openNew(one) },
          ...(act.popOut ? [{ label: t("tabStrip.popOut"), onSelect: () => act.popOut!(one) }] : []),
          { label: t("articleMenu.openPage"), onSelect: () => act.page(one), disabled: local && !one.pdf },
          { label: t("articleMenu.copyUrl"), onSelect: () => act.copyUrl(one), disabled: local },
          "-",
          { label: t("browserView.remove"), onSelect: () => act.remove(one), danger: true },
        ]
      : []),
  ];
}
