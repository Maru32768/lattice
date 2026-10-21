// Sample library for the mock backend: specs import it to compute what the UI should show.
import type { ArticleRow, Block, ChatMessage, ChatThread, FeedFilter, FeedRow, FolderRow, GroupRow, JobOverview, JobRow, Quiz, QuizQuestion, QuizReviewItem, RejectedEntry, ReviewItem, VocabEntry } from "../src/api.ts";

/** The clock every spec runs at (`page.clock.setFixedTime`), so 最近追加 is stable. */
export const NOW = Date.parse("2026-10-20T03:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000 - 3_600_000).toISOString();

export const FEEDS: FeedRow[] = [
  { id: 1, url: "https://postgresweekly.com/rss/", title: "Postgres Weekly", custom_title: null, has_icon: false, site_url: "https://postgresweekly.com", last_fetched_at: daysAgo(0), last_error: null, article_count: 0, rejected: 0, filtered: false, filter_note: null, folder_id: null, folder: null },
  { id: 2, url: "https://netflixtechblog.com/feed", title: "Netflix TechBlog", custom_title: null, has_icon: false, site_url: "https://netflixtechblog.com", last_fetched_at: daysAgo(0), last_error: null, article_count: 0, rejected: 0, filtered: false, filter_note: null, folder_id: null, folder: null },
  { id: 3, url: "https://web.dev/feed.xml", title: "web.dev", custom_title: null, has_icon: false, site_url: "https://web.dev", last_fetched_at: daysAgo(1), last_error: null, article_count: 0, rejected: 0, filtered: false, filter_note: null, folder_id: null, folder: null },
  { id: 4, url: "https://zenn.dev/feed", title: "Zenn トレンド", custom_title: "Zenn", has_icon: false, site_url: "https://zenn.dev", last_fetched_at: daysAgo(0), last_error: null, article_count: 0, rejected: 0, filtered: false, filter_note: null, folder_id: null, folder: null },
  { id: 5, url: "https://blog.rust-lang.org/feed.xml", title: "Rust Blog", custom_title: null, has_icon: false, site_url: "https://blog.rust-lang.org", last_fetched_at: daysAgo(2), last_error: null, article_count: 0, rejected: 0, filtered: false, filter_note: null, folder_id: null, folder: null },
  { id: 6, url: "https://lwn.net/headlines/rss", title: "LWN.net", custom_title: null, has_icon: false, site_url: "https://lwn.net", last_fetched_at: daysAgo(3), last_error: "HTTP 503 Service Unavailable", article_count: 0, rejected: 0, filtered: false, filter_note: null, folder_id: null, folder: null },
];

const FEED_DOMAIN: Record<number, string> = { 1: "postgresweekly.com", 2: "netflixtechblog.com", 3: "web.dev", 4: "zenn.dev", 5: "blog.rust-lang.org" };

type Row = [title: string, feed: number | string | null, genre: string | null, tags: string[], difficulty: number | null, read: boolean, favorite: boolean, days: number, extra?: Partial<ArticleRow>];

// feed: a feed id, or the domain of a manually added article.
const ROWS: Row[] = [
  ["Snapshot isolation in PostgreSQL, explained", 1, "データベース", ["postgres", "mvcc"], 3, false, true, 0],
  ["Understanding MVCC bloat and VACUUM", 1, "データベース", ["postgres", "mvcc", "performance"], 4, false, false, 1],
  ["Logical replication slots in production", 1, "データベース", ["postgres", "replication"], 4, true, false, 3],
  ["Indexing JSONB columns", 1, "データベース", ["postgres", "json"], 2, true, false, 9],
  ["Postgres 18: asynchronous I/O", 1, "データベース", ["postgres", "performance"], 3, false, false, 2],
  ["SQLite as an application file format", "sqlite.org", "データベース", ["sqlite"], 2, true, true, 20],
  ["How SQLite's WAL mode works", "sqlite.org", "データベース", ["sqlite", "wal"], 3, false, false, 4],
  ["Zero-downtime migrations at Netflix", 2, "分散システム", ["kafka", "migration"], 4, false, false, 0],
  ["Building a resilient event pipeline with Kafka", 2, "分散システム", ["kafka", "streaming"], 3, true, false, 6],
  ["Raft consensus from scratch", "raft.github.io", "分散システム", ["raft", "consensus"], 5, false, true, 12],
  ["Chaos engineering at scale", 2, "分散システム", ["resilience"], 3, true, false, 30],
  ["Distributed tracing with OpenTelemetry", 2, "分散システム", ["observability", "tracing"], 2, false, false, 5],
  ["Exactly-once semantics, demystified", 2, "分散システム", ["kafka", "streaming", "consensus"], 4, false, false, 8],
  ["Interop 2026: what shipped", 3, "フロントエンド", ["css", "browsers"], 1, false, false, 1],
  ["Container queries in practice", 3, "フロントエンド", ["css"], 2, true, false, 10],
  ["Optimizing INP with scheduler.yield", 3, "フロントエンド", ["performance", "javascript"], 3, false, false, 2],
  ["React Server Components without a framework", "overreacted.io", "フロントエンド", ["react", "javascript"], 4, false, false, 3],
  ["View transitions for multi-page apps", 3, "フロントエンド", ["css", "browsers"], 2, true, false, 15],
  ["WebAssembly components and WASI 0.3", "bytecodealliance.org", "フロントエンド", ["wasm", "rust"], 4, false, false, 7],
  ["Rust 2027 edition preview", 5, "プログラミング言語", ["rust"], 2, false, false, 0],
  ["Async closures are stable", 5, "プログラミング言語", ["rust", "async"], 3, true, false, 18],
  ["Ownership for C++ programmers", "cppstories.com", "プログラミング言語", ["rust", "cpp"], 2, true, false, 40],
  ["Writing a borrow-checker-friendly graph", "smallcultfollowing.com", "プログラミング言語", ["rust"], 4, false, false, 9, { thin: true }],
  ["Supply-chain attacks on npm", "socket.dev", "セキュリティ", ["security", "javascript"], 3, false, false, 1],
  ["Passkeys deployment checklist", "passkeys.dev", "セキュリティ", ["security", "auth"], 2, true, false, 25],
  ["Memory tagging on ARM", "lwn.net", "セキュリティ", ["security", "hardware"], 5, false, false, 13, { fetch_status: "failed", extraction_status: "pending", last_error: "HTTP 403 Forbidden" }],
  ["Prompt injection in agent tools", "simonwillison.net", "セキュリティ", ["security", "llm"], 3, false, true, 2],
  ["Retrieval-augmented generation evaluation", "eugeneyan.com", "機械学習", ["llm", "rag"], 4, false, false, 4],
  ["Tokenizers: BPE vs unigram", "huggingface.co", "機械学習", ["llm", "nlp"], 3, true, false, 11],
  ["Quantization for local inference", "huggingface.co", "機械学習", ["llm", "performance"], 4, false, false, 6],
  ["Postgres の MVCC を図で理解する", 4, "データベース", ["postgres", "mvcc"], 2, false, false, 1, { language: "ja" }],
  ["Rust の所有権を 10 分で", 4, "プログラミング言語", ["rust"], 1, false, false, 3, { language: "ja" }],
  ["React 19 の use フック入門", 4, "フロントエンド", ["react"], 2, true, false, 8, { language: "ja" }],
  ["Kafka のパーティション設計", 4, "分散システム", ["kafka"], 3, false, false, 5, { language: "ja" }],
  ["LLM エージェントの評価方法", 4, "機械学習", ["llm"], 3, false, false, 0, { language: "ja" }],
  ["読書メモ: Designing Data-Intensive Applications", "", null, ["mvcc", "books"], null, false, false, 2, { original_url: "local:md/5f2c0e9a7d1b4c3e8a6f0b2d4e6c8a1f3b5d7e9f1a2c4e6b8d0f2a4c6e8b0d2f" }],
  ["", "example.org", null, [], null, false, false, 0, { title: null, original_url: "https://example.org/drafts/pending", fetch_status: "pending", extraction_status: "pending" }],
  ["An essay on cache invalidation", "martinfowler.com", null, ["performance"], null, true, false, 16],
  ["CRDTs for collaborative editing", "inkandswitch.com", "分散システム", ["crdt", "consensus"], 5, false, false, 21],
  ["HTTP/3 and QUIC in production", "blog.cloudflare.com", "ネットワーク", ["http", "performance"], 3, true, false, 35],
];

/** Importance by article id: [score, reason, judged against an earlier profile]. */
const RELEVANCE: Record<number, [number, string, boolean]> = {
  1: [5, "PostgreSQL の MVCC を扱う仕事に直結する", false],
  2: [4, "VACUUM の運用はデータベース担当として重要", false],
  8: [4, "移行作業の進め方が参考になる", true],
  14: [2, "フロントエンドは関心の外", false],
};

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "article";

export const ARTICLES: ArticleRow[] = ROWS.map(([title, feed, genre, tags, difficulty, read, favorite, days, extra], i) => {
  const id = i + 1;
  const feedId = typeof feed === "number" ? feed : null;
  const domain = feedId != null ? FEED_DOMAIN[feedId] : typeof feed === "string" ? feed : "";
  const f = FEEDS.find((x) => x.id === feedId);
  return {
    id,
    original_url: `https://${domain}/posts/${slug(title)}-${id}`,
    canonical_url: null,
    domain,
    title,
    author: null,
    site_name: null,
    published_at: daysAgo(days + 1),
    language: "en",
    saved_at: daysAgo(days),
    fetch_status: "ok",
    extraction_status: "ok",
    last_error: null,
    read_status: read ? "read" : "unread",
    favorite,
    tags,
    groups: [],
    genre,
    genre_manual: false,
    difficulty,
    difficulty_manual: false,
    feed_id: feedId,
    feed_title: f ? (f.custom_title ?? f.title) : null,
    folder_id: null,
    thin: false,
    from_feed: false,
    pdf: false,
    relevance: RELEVANCE[id]?.[0] ?? null,
    relevance_reason: RELEVANCE[id]?.[1] ?? null,
    relevance_stale: RELEVANCE[id]?.[2] ?? false,
    ...extra,
  };
});
for (const f of FEEDS) f.article_count = ARTICLES.filter((a) => a.feed_id === f.id).length;

/** Feed folders (H25): none until a spec makes them. */
export const FOLDERS: FolderRow[] = [];

/** User-made groups (G53); `count` is filled from the memberships below. */
export const GROUPS: GroupRow[] = [
  { id: 1, name: "MVCC 調査", created_at: daysAgo(10), count: 0 },
  { id: 2, name: "Rust 勉強会", created_at: daysAgo(5), count: 0 },
  { id: 3, name: "空のグループ", created_at: daysAgo(1), count: 0 },
];
const MEMBERS: Record<number, number[]> = { 1: [1, 2, 31, 36], 2: [20, 21, 22, 32] };
for (const [g, ids] of Object.entries(MEMBERS)) for (const id of ids) ARTICLES[id - 1].groups.push(Number(g));

/** Import filters by feed id; 0 is the global one. */
export const FEED_FILTERS: Record<number, FeedFilter> = {
  1: { rules: [{ field: "title", action: "exclude", pattern: "sponsored", regex: false }], min_chars: null, llm: true, instruction: "Postgres の内部実装だけ", min_relevance: null },
};

/** Entries the filters kept out, by feed id. */
export const REJECTED: Record<number, RejectedEntry[]> = {
  1: [
    {
      url: "https://postgresweekly.com/posts/sponsored-managed-postgres", title: "Sponsored: managed Postgres in one click", published_at: daysAgo(0),
      excerpt: "Try our hosted database.", reason: { kind: "excluded", scope: "feed", rule: FEED_FILTERS[1].rules[0] },
    },
    {
      url: "https://postgresweekly.com/posts/meetup-tokyo", title: "Postgres meetup in Tokyo", published_at: daysAgo(1),
      excerpt: "Join us next month.", reason: { kind: "llm", reason: "イベント告知で内部実装の記事ではない", score: 2 },
    },
  ],
};
for (const f of FEEDS) {
  f.rejected = REJECTED[f.id]?.length ?? 0;
  f.filtered = f.id in FEED_FILTERS;
}
FEEDS[1].filter_note = JSON.stringify({ code: "feedFilter.llmFailed", params: { error: "usage limit reached" } });

/** The article the Reader specs open: fully translated, with a semantic-only search hit. */
export const SNAPSHOT_ID = 1;
export const MARKDOWN_ID = 36;

const SNAPSHOT_BLOCKS: [Block["kind"], string, string | null, Block["attrs"]?][] = [
  ["heading", "Snapshot isolation", "スナップショット分離", { level: 2 }],
  ["paragraph", "Every transaction reads from a consistent snapshot taken when it starts.", "各トランザクションは、開始時点の一貫したスナップショットから読み取る。"],
  ["paragraph", "PostgreSQL implements it with multi-version concurrency control.", "PostgreSQL はこれを MVCC で実装している。"],
  ["list_item", "Readers never block writers.", "読み取りは書き込みを妨げない。", { depth: 0 }],
  ["code", "BEGIN ISOLATION LEVEL REPEATABLE READ;", null, { lang: "sql" }],
  ["paragraph", "Write skew is still possible under snapshot isolation.", "スナップショット分離でも write skew は起こりうる。"],
];

function genericBlocks(a: ArticleRow): [Block["kind"], string, string | null, Block["attrs"]?][] {
  // Every third article is not translated yet; Japanese articles translate into English.
  const tr = (s: string) => (a.id % 3 !== 0 ? s : null);
  const topic = a.tags.join(", ") || "the topic";
  if (a.language === "ja") {
    return [
      ["heading", "はじめに", tr("Introduction"), { level: 2 }],
      ["paragraph", `${a.title ?? ""}について、${topic} を中心に解説する。`, tr(`An explanation of ${topic}.`)],
      ["paragraph", "実運用で得た知見をまとめた。", tr("Lessons learned in production.")],
    ];
  }
  return [
    ["heading", "Overview", tr("概要"), { level: 2 }],
    ["paragraph", `${a.title ?? ""}. This post looks at ${topic}.`, tr(`${topic} について扱う記事。`)],
    ["paragraph", "Key takeaways for working engineers.", tr("現場のエンジニア向けの要点。")],
    ["list_item", "Measure before you optimize.", tr("最適化の前に計測する。"), { depth: 0 }],
  ];
}

export function blocksOf(a: ArticleRow): Block[] {
  if (a.fetch_status !== "ok") return [];
  const spec = a.id === SNAPSHOT_ID ? SNAPSHOT_BLOCKS : genericBlocks(a);
  return spec.map(([kind, text, translation, attrs], i) => ({
    id: a.id * 100 + i + 1,
    ordinal: i,
    heading_id: kind === "heading" ? null : a.id * 100 + 1,
    kind,
    text,
    attrs: attrs ?? {},
    translation,
  }));
}

export function jobsOf(a: ArticleRow): JobRow[] {
  const translated = a.id === SNAPSHOT_ID || a.id % 3 !== 0;
  return translated && a.fetch_status === "ok"
    ? [{ id: 1000 + a.id, type: "translate", article_id: a.id, params: null, status: "succeeded", attempt_count: 1, last_error: null, next_run_at: null }]
    : [];
}

export const SUMMARIES: Record<number, string> = {
  [SNAPSHOT_ID]: "- スナップショット分離は、トランザクション開始時点のスナップショットから読む。\n- PostgreSQL は MVCC で実装する。\n- write skew は防げない。",
};

export const JOBS: JobOverview = {
  counts: [
    { job_type: "ingest", state: "pending", count: 1 },
    { job_type: "translate", state: "running", count: 1 },
    { job_type: "translate", state: "failed", count: 2 },
    { job_type: "classify", state: "backoff", count: 1 },
  ],
  issues: [
    { id: 501, job_type: "translate", article_id: 9, article_title: ARTICLES[8].title, status: "failed", attempt_count: 5, last_error: "usage limit reached", next_run_at: null, created_at: daysAgo(1), started_at: daysAgo(1), completed_at: daysAgo(1) },
    { id: 502, job_type: "translate", article_id: 15, article_title: ARTICLES[14].title, status: "failed", attempt_count: 5, last_error: "timeout after 120 s", next_run_at: null, created_at: daysAgo(2), started_at: daysAgo(2), completed_at: daysAgo(2) },
    { id: 503, job_type: "classify", article_id: 37, article_title: null, status: "pending", attempt_count: 2, last_error: "provider returned malformed JSON", next_run_at: daysAgo(-0.01), created_at: daysAgo(0), started_at: null, completed_at: null },
  ],
};

export const CHAT_THREADS: ChatThread[] = [
  { id: 1, title: "MVCC と VACUUM の関係", updated_at: daysAgo(1) },
  { id: 2, title: "Kafka の exactly-once", updated_at: daysAgo(4) },
];

export const CHAT_MESSAGES: ChatMessage[] = [
  {
    id: 1, thread_id: 1, question: "MVCC で VACUUM が必要なのはなぜ？",
    answer: "古い版の行が残るため、VACUUM が不要になった版を回収します [1]。スナップショットが古い版を読む間は回収できません [2]。",
    citations: [
      { n: 1, block_id: 202, article_id: 2, url: ARTICLES[1].original_url, title: ARTICLES[1].title!, heading: "Overview", text: blocksOf(ARTICLES[1])[1].text },
      { n: 2, block_id: 102, article_id: 1, url: ARTICLES[0].original_url, title: ARTICLES[0].title!, heading: "Snapshot isolation", text: SNAPSHOT_BLOCKS[1][1] },
    ],
    scope: { kind: "filter", filter: { kind: "tag", name: "mvcc" } }, mode: "retrieval", provider: "claude_cli", model: null, created_at: daysAgo(1),
  },
];

/** The snapshot article's quiz: a multiple-choice, a recall and another multiple-choice question. */
export const QUIZ: Quiz = {
  id: 1, created_at: daysAgo(0), stale: false, in_review: 0,
  questions: [
    { id: 11, kind: "choice", question: "PostgreSQL はスナップショット分離を何で実装している？", options: ["2 相ロック", "MVCC", "WAL のリプレイ", "楽観ロックだけ"],
      answer: "MVCC", explanation: "行の複数の版を持ち、各トランザクションは自分のスナップショットに見える版を読む。", block_ids: [103] },
    { id: 12, kind: "recall", question: "スナップショット分離でも起こりうる異常は？", answer: "write skew",
      explanation: "別々の行を読んで書く 2 つのトランザクションは、互いの書き込みを検出できない。", block_ids: [106] },
    { id: 13, kind: "choice", question: "スナップショット分離で、読み取りは書き込みを妨げる？", options: ["妨げる", "妨げない", "行ロック次第", "WAL 次第"],
      answer: "妨げない", explanation: "読み取りは古い版を読むので、書き込みを待たせない。", block_ids: [104] },
  ],
};

/** A new card's intervals (minutes) after again / hard / good / easy with the default settings. */
export const NEW_PREVIEWS: ReviewItem["previews"] = [1440, 1440, 1440, 5760];

const card = (a: ArticleRow, q: QuizQuestion): QuizReviewItem => ({ ...q, type: "quiz", article_id: a.id, article_title: a.title!, new: false, previews: [1440, 2880, 8640, 11520] });

/** Today's review: two due cards from the VACUUM article. */
export const REVIEW: QuizReviewItem[] = [
  card(ARTICLES[1], { id: 21, kind: "recall", question: "VACUUM が回収するのは何？", answer: "どのスナップショットからも見えなくなった古い版の行", explanation: "MVCC では更新のたびに古い版が残る。", block_ids: [202] }),
  card(ARTICLES[1], { id: 22, kind: "choice", question: "bloat が増える主な原因は？", options: ["長いトランザクション", "インデックスの不足", "WAL の圧縮", "共有バッファの不足"],
    answer: "長いトランザクション", explanation: "古いスナップショットが残る間、VACUUM は版を回収できない。", block_ids: [203] }),
];

/** The vocabulary: a word saved from the snapshot article (its cards not due today) and one the LLM could not explain. */
export const VOCAB: VocabEntry[] = [
  {
    id: 2, headword: "write skew", pos: "noun", meaning: "書き込みスキュー", definition: "Write skew is when two transactions each change data based on something the other one changes.",
    ipa: "", example: "Write skew broke the on-call invariant.", state: "ready", suspended: false, created_at: daysAgo(2), due_at: NOW / 1000 + 3 * 86_400,
    contexts: [{ surface: "Write skew", sentence: SNAPSHOT_BLOCKS[5][1], article_id: SNAPSHOT_ID, block_id: 106, url: ARTICLES[0].original_url, title: ARTICLES[0].title }],
  },
  {
    id: 1, headword: "bloat", pos: "", meaning: "", definition: "", ipa: "", example: "", state: "failed", suspended: false, created_at: daysAgo(3), due_at: null,
    contexts: [{ surface: "bloat", sentence: "Table bloat grows while old snapshots live.", article_id: null, block_id: null, url: "https://wiki.example.org/vacuum", title: null }],
  },
];
