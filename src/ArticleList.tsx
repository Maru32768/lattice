import { useMemo, useState } from "react";
import type { ArticleRow, ArticleSort } from "./api";
import { type Group, type ListMode, groupArticles } from "./groups";

const MODES: [ListMode, string][] = [["list", "一覧"], ["feed", "フィード"], ["genre", "ジャンル"]];
const SORTS: [ArticleSort, string][] = [
  ["saved_desc", "追加日時（新しい順）"],
  ["saved_asc", "追加日時（古い順）"],
  ["published_desc", "公開日時（新しい順）"],
];

/** The sidebar list: flat, or grouped by feed → genre / by genre. Only open groups render their articles. */
export function ArticleList({ articles, sort, onSort, renderItem }: {
  articles: ArticleRow[];
  sort: ArticleSort;
  onSort: (s: ArticleSort) => void;
  renderItem: (a: ArticleRow) => React.ReactNode;
}) {
  const [mode, setMode] = useState<ListMode>("list");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = useMemo(() => (mode === "list" ? [] : groupArticles(articles, mode)), [articles, mode]);

  function toggle(path: string) {
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(path)) n.add(path);
      return n;
    });
  }

  function renderGroup(g: Group<ArticleRow>, parent: string, depth: number): React.ReactNode {
    const path = `${parent}/${g.key}`;
    const isOpen = open.has(path);
    return (
      <li key={path}>
        <button className="group-head" style={{ paddingLeft: 12 + depth * 14 }} aria-expanded={isOpen} onClick={() => toggle(path)}>
          <span className="caret">{isOpen ? "▾" : "▸"}</span>
          <span className="label">{g.label}</span>
          <span className="count">{g.articles.length}</span>
        </button>
        {isOpen && (
          <ul className="group-body">
            {g.children ? g.children.map((c) => renderGroup(c, path, depth + 1)) : g.articles.map(renderItem)}
          </ul>
        )}
      </li>
    );
  }

  return (
    <>
      <div className="list-controls">
        <div className="segmented" role="radiogroup" aria-label="表示モード">
          {MODES.map(([m, label]) => (
            <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{label}</button>
          ))}
        </div>
        <select value={sort} onChange={(e) => onSort(e.target.value as ArticleSort)} aria-label="並び順">
          {SORTS.map(([s, label]) => <option key={s} value={s}>{label}</option>)}
        </select>
      </div>
      <ul className="list">
        {mode === "list" ? articles.map(renderItem) : groups.map((g) => renderGroup(g, mode, 0))}
      </ul>
    </>
  );
}
