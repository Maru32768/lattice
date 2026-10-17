import type { ArticleFilter, FeedRow, TagCount } from "./api";
import { MANUAL, UNCLASSIFIED } from "./groups.ts";

export interface FilterGroup {
  label: string;
  options: { key: string; label: string }[];
}

/** `<select>` values for filters; `parseFilterKey` gives the filter back. */
export const filterKey = (f: ArticleFilter) => JSON.stringify(f);
export const parseFilterKey = (k: string) => JSON.parse(k) as ArticleFilter;

/** Genre / feed / tag filters as `<optgroup>`s for the search and chat scope pickers. Empty genres are left out. */
export function filterGroups(genres: TagCount[], feeds: FeedRow[], tags: TagCount[]): FilterGroup[] {
  const opt = (f: ArticleFilter, label: string) => ({ key: filterKey(f), label });
  return [
    {
      label: "ジャンル",
      options: [
        ...genres.filter((g) => g.count > 0).map((g) => opt({ kind: "genre", name: g.name }, `${g.name}（${g.count}件）`)),
        opt({ kind: "genre", name: null }, UNCLASSIFIED),
      ],
    },
    {
      label: "フィード",
      options: [
        opt({ kind: "feed", id: null }, MANUAL),
        ...feeds.map((f) => opt({ kind: "feed", id: f.id }, `${f.title ?? f.url}（${f.article_count}件）`)),
      ],
    },
    { label: "タグ", options: tags.map((t) => opt({ kind: "tag", name: t.name }, `#${t.name}（${t.count}件）`)) },
  ].filter((g) => g.options.length > 0);
}
