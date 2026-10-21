import type { ArticleFilter, FeedRow, FolderRow, GroupRow, TagCount } from "./api";
import { feedName } from "./groups.ts";
import type { T } from "./i18n/index.ts";

export interface FilterGroup {
  label: string;
  options: { key: string; label: string }[];
}

/** `<select>` values for filters; `parseFilterKey` gives the filter back. */
export const filterKey = (f: ArticleFilter) => JSON.stringify(f);
export const parseFilterKey = (k: string) => JSON.parse(k) as ArticleFilter;

/** Group / genre / feed (and feed folder) / tag filters as `<optgroup>`s for the search and chat scope pickers. Empty genres are left out. */
export function filterGroups(groups: GroupRow[], genres: TagCount[], feeds: FeedRow[], tags: TagCount[], t: T, folders: FolderRow[] = []): FilterGroup[] {
  const opt = (f: ArticleFilter, label: string) => ({ key: filterKey(f), label });
  return [
    { label: t("common.group"), options: groups.map((g) => opt({ kind: "group", id: g.id }, t("scopes.option", { name: g.name, count: g.count }))) },
    {
      label: t("common.genre"),
      options: [
        ...genres.filter((g) => g.count > 0).map((g) => opt({ kind: "genre", name: g.name }, t("scopes.option", { name: g.name, count: g.count }))),
        opt({ kind: "genre", name: null }, t("common.unclassified")),
      ],
    },
    {
      label: t("common.feed"),
      options: [
        opt({ kind: "feed", id: null }, t("common.manual")),
        ...folders.map((f) => opt({ kind: "folder", id: f.id }, t("scopes.folderOption", { name: f.name }))),
        ...feeds.map((f) => opt({ kind: "feed", id: f.id }, t("scopes.option", { name: feedName(f), count: f.article_count }))),
      ],
    },
    { label: t("common.tag"), options: tags.map((tag) => opt({ kind: "tag", name: tag.name }, t("scopes.option", { name: `#${tag.name}`, count: tag.count }))) },
  ].filter((g) => g.options.length > 0);
}
