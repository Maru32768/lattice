import type { SearchHit, SearchResult } from "./api";
import { excerpt, highlight, terms } from "./search";

const SOURCE_LABEL = { lexical: "全文", semantic: "意味", both: "全文+意味" } as const;

function Marked({ text, ts }: { text: string; ts: string[] }) {
  return <>{highlight(excerpt(text, ts), ts).map((s, i) => (s.mark ? <mark key={i}>{s.v}</mark> : s.v))}</>;
}

export function SearchResults({ query, result, onOpen }: {
  query: string;
  result: SearchResult;
  onOpen: (hit: SearchHit) => void;
}) {
  const ts = terms(query);
  return (
    <section className="results" aria-label="検索結果">
      <h2>「{query}」の検索結果 <span className="count">{result.hits.length}件</span></h2>
      {result.semantic_error && (
        <p className="notice">意味検索は利用できないため、全文検索の結果のみ表示しています: {result.semantic_error}</p>
      )}
      {result.hits.length === 0 && <p className="empty">該当する箇所はありません。</p>}
      <ol>
        {result.hits.map((h) => (
          <li key={h.block_id}>
            <button className="hit" onClick={() => onOpen(h)}>
              <span className="hit-head">
                <span className="hit-title">{h.article_title}</span>
                {h.heading && h.heading !== h.text && <span className="hit-section">› {h.heading}</span>}
                <span className={`badge ${h.source}`}>{SOURCE_LABEL[h.source]}</span>
              </span>
              <span className="hit-text"><Marked text={h.text} ts={ts} /></span>
              {h.translation && <span className="hit-translation"><Marked text={h.translation} ts={ts} /></span>}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
