import type { ChatScope } from "../api";
import { type FilterGroup, parseFilterKey } from "../library/scopes.ts";
import type { T } from "../i18n/index.ts";
import type { PickOption, PickSection } from "../ui/pickRows.ts";

/** Splits an answer into text and `[n]` markers; only numbers in `cited` become markers. */
export function splitCitations(answer: string, cited: Set<number>): ({ n: number } | string)[] {
  return answer
    .split(/(\[\d+\])/)
    .map((p) => {
      const n = Number(/^\[(\d+)\]$/.exec(p)?.[1]);
      return cited.has(n) ? { n } : p;
    })
    .filter((p) => p !== "");
}

/** The draft with `quote` added to ask about: a Markdown quote on its own line, with the question to come after it. */
export const withQuote = (draft: string, quote: string) => `${draft && !draft.endsWith("\n") ? `${draft}\n` : draft}> ${quote}\n`;

/** A saved article open in a tab, as a chat scope option. */
export interface OpenDoc {
  id: number;
  title: string;
}

/**
 * The saved articles in `tabs`, once each, in tab order. A page tab counts by the article it was
 * saved as; a page not in the Index has no stored text for the chat to answer from, so it is left out.
 */
export function openDocs(
  tabs: ({ kind: "reader"; articleId: number } | { kind: "page"; saved: number | null })[],
  titleOf: (id: number) => string | null,
): OpenDoc[] {
  const out = new Map<number, OpenDoc>();
  for (const t of tabs) {
    const id = t.kind === "reader" ? t.articleId : t.saved;
    const title = id == null || out.has(id) ? null : titleOf(id);
    if (id != null && title != null) {
      out.set(id, { id, title });
    }
  }
  return [...out.values()];
}

/** Several windows' open articles as one list, each article once. */
export const mergeDocs = (lists: OpenDoc[][]): OpenDoc[] => [...new Map(lists.flat().map((d) => [d.id, d])).values()];

/** Scope keys for the open articles: all of them, or one by id (the other keys are `article`, `all` and filter keys). */
export const OPEN_ALL = "open";
export const openKey = (id: number) => `open:${id}`;

/** What a scope key asks over; null while it names nothing (no article open, no tab open). */
export function scopeOf(key: string, article: { id: number } | null, open: OpenDoc[]): ChatScope | null {
  if (key === "article") {
    return article && { kind: "article", id: article.id };
  }
  if (key === OPEN_ALL) {
    return open.length ? { kind: "articles", ids: open.map((d) => d.id) } : null;
  }
  if (key.startsWith("open:")) {
    return { kind: "article", id: Number(key.slice(5)) };
  }
  return { kind: "filter", filter: key === "all" ? { kind: "all" } : parseFilterKey(key) };
}

/** The scope options: この記事, 開いている記事すべて, 全記事 and the list's scope, then the open articles one by one, then `groups`. */
export function scopeSections(
  t: T,
  article: { title: string } | null,
  open: OpenDoc[],
  current: { key: string; label: string } | null,
  groups: FilterGroup[],
): PickSection[] {
  const first: PickOption[] = [
    {
      key: "article",
      label: t("chatPane.thisArticle") + (article ? t("chatPane.articleTitle", { title: article.title }) : t("chatPane.noArticle")),
      disabled: !article,
    },
    { key: OPEN_ALL, label: t("chatPane.allOpen", { n: open.length }), disabled: open.length === 0 },
    { key: "all", label: t("chatPane.allArticles") },
  ];
  if (current) {
    const group = parseFilterKey(current.key).kind === "group";
    first.push({ key: current.key, label: group ? t("chatPane.thisGroup", { label: current.label }) : t("chatPane.currentList", { label: current.label }) });
  }
  return [
    { label: "", options: first },
    ...(open.length ? [{ label: t("chatPane.openGroup"), options: open.map((d) => ({ key: openKey(d.id), label: d.title })) }] : []),
    ...groups,
  ];
}
