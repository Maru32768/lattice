import { useMemo } from "react";
import type { ArticleRow, FeedRow, FolderRow, GroupRow, RelevanceStatus } from "../api";
import type { T } from "../i18n";
import { feedGroups, folderTree } from "../feeds/feedFolders";
import { flatten, groupArticles, type Group } from "../library/groups";
import { countBy, inScope, listed, relaxations, type Facets, type Kept, type Scope } from "../library/library";
import type { NavCounts } from "../library/Nav";
import type { Grouping } from "../library/ListPane";

/** 重要 shows once there is a profile to judge against (or scores from an earlier one): its threshold, else null. */
export const importantMinOf = (r: RelevanceStatus | null) => (r && (r.has_profile || r.scored > 0) ? r.threshold : null);

/** What the list, the sidebar and the empty-list hints show of the library for the current scope and facets. */
export function useLibraryView({
  articles,
  feeds,
  folders,
  groupRows,
  scope,
  facets,
  kept,
  group,
  importantMin,
  now,
  t,
}: {
  articles: ArticleRow[];
  feeds: FeedRow[];
  folders: FolderRow[];
  groupRows: GroupRow[];
  scope: Scope;
  facets: Facets;
  kept: Kept;
  group: Grouping;
  importantMin: number | null;
  now: number;
  t: T;
}) {
  const { scoped, shown } = useMemo(() => listed(articles, scope, facets, now, kept), [articles, scope, facets, now, kept]);
  // The sidebar's order: each folder's feeds, then the loose ones.
  const feedOrder = useMemo(() => feedGroups(folderTree(feeds, folders, new Map())).flatMap((o) => o.ids), [feeds, folders]);
  const groups: Group<ArticleRow>[] = useMemo(
    () => (group === "none" ? [{ key: "all", label: "", articles: shown }] : groupArticles(shown, group, t, feedOrder)),
    [shown, group, t, feedOrder],
  );
  const order = useMemo(() => flatten(groups), [groups]);
  const counts: NavCounts = useMemo(() => {
    const unread = articles.filter((a) => a.read_status === "unread");
    return {
      recent: articles.filter((a) => inScope(a, { kind: "recent" }, now)).length,
      important: importantMin == null ? 0 : articles.filter((a) => inScope(a, { kind: "important", min: importantMin }, now)).length,
      unread: unread.length,
      favorites: articles.filter((a) => a.favorite).length,
      all: articles.length,
      manual: articles.filter((a) => a.feed_id == null).length,
      genres: [...countBy(articles, "genres")].sort((a, b) => (a[0] == null ? 1 : b[0] == null ? -1 : b[1] - a[1])),
      feedUnread: countBy(unread, "feeds"),
    };
  }, [articles, now, importantMin]);
  const relax = useMemo(
    () => (shown.length === 0 && articles.length > 0 ? relaxations(articles, groupRows, scope, facets, now, t, folders, feeds) : []),
    [shown.length, articles, groupRows, scope, facets, now, t, folders, feeds],
  );
  const articleById = useMemo(() => new Map(articles.map((a) => [a.id, a])), [articles]);
  return { scoped, shown, groups, order, counts, relax, articleById };
}
