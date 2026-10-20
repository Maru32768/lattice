// The mock backend: one handler per command in src/api.ts, over an in-memory copy of the
// fixtures. `commands.test.ts` fails when api.ts calls a command this table does not answer.
import type {
  ArticleFilter, ArticleRow, ArticleSort, ArticleView, ChainEntry, ChatBudget, ChatMessage, ChatScope, CustomInstructions, FeedCandidate, ImageSettings,
  Grade, LlmSettings, Quiz, R2Settings, R2Status, ReviewItem, ReviewOverview, ReviewSettings, SearchHit, SearchResult, Settings, TagCount, UpdateInfo,
} from "../src/api.ts";
import { ARTICLES, CHAT_MESSAGES, CHAT_THREADS, FEEDS, JOBS, NEW_PREVIEWS, NOW, QUIZ, REVIEW, SUMMARIES, blocksOf, jobsOf } from "./fixtures.ts";

const articles = structuredClone(ARTICLES);
const feeds = structuredClone(FEEDS);
const threads = structuredClone(CHAT_THREADS);
const messages = structuredClone(CHAT_MESSAGES);
const jobs = structuredClone(JOBS);
/** Quizzes by article; review cards by question id (`due`: in today's queue). */
const quizzes = new Map<number, Quiz>([[1, structuredClone(QUIZ)]]);
const cards = new Map<number, { item: ReviewItem; due: boolean }>(REVIEW.map((r) => [r.id, { item: structuredClone(r), due: true }]));
const store = {
  autoRender: true,
  autoClassify: true,
  taskbarBadge: true,
  uiLanguage: null as string | null,
  keepTerms: true,
  translateInstructions: "",
  custom: { profile: "", summary: "", chat: "" },
  chatBudget: "standard" as ChatBudget,
  images: { save: true, max_mb: 5 } as ImageSettings,
  backupKeep: 5,
  llm: {
    chain: [{ kind: "claude_cli", model: null, effort: null }, { kind: "openai", model: "gpt-5-mini", effort: "low" }],
    openai_key: "env", gemini_key: null, anthropic_key: "stored",
  } as LlmSettings,
  review: { new_per_day: 20, reviews_per_day: 200, min_interval_minutes: 1440, max_interval_days: 365 },
  r2: {
    enabled: false, account_id: "", bucket: "", access_key_id: "", interval_hours: 24, keep_generations: 7, has_secret: false,
    last_success: null, last_key: null, last_error: null, last_prune_error: null, running: false,
  } as R2Status,
};

const article = (id: number) => {
  const a = articles.find((x) => x.id === id);
  if (!a) throw new Error(`no article ${id}`);
  return a;
};

function matches(a: ArticleRow, f: ArticleFilter | null): boolean {
  if (!f) return true;
  switch (f.kind) {
    case "all": return true;
    case "unread": return a.read_status === "unread";
    case "favorites": return a.favorite;
    case "tag": return a.tags.includes(f.name);
    case "genre": return a.genre === f.name;
    case "feed": return a.feed_id === f.id;
  }
}

const SORTERS: Record<ArticleSort, (a: ArticleRow, b: ArticleRow) => number> = {
  saved_desc: (a, b) => b.saved_at.localeCompare(a.saved_at) || b.id - a.id,
  saved_asc: (a, b) => a.saved_at.localeCompare(b.saved_at) || a.id - b.id,
  published_desc: (a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? "") || b.id - a.id,
  difficulty_asc: (a, b) => (a.difficulty ?? 9) - (b.difficulty ?? 9) || b.id - a.id,
};

const counts = (values: (string | null)[]): TagCount[] => {
  const m = new Map<string, number>();
  for (const v of values) if (v != null) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

/** Lexical: the query is in the original text; semantic: only in the translation. */
function search(query: string, filter: ArticleFilter | null): SearchResult {
  const q = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  for (const a of articles.filter((x) => matches(x, filter))) {
    const blocks = blocksOf(a);
    for (const b of blocks) {
      const lexical = b.text.toLowerCase().includes(q);
      const semantic = !!b.translation?.toLowerCase().includes(q);
      if (!q || (!lexical && !semantic)) continue;
      const heading = blocks.find((h) => h.id === b.heading_id)?.text ?? null;
      hits.push({
        block_id: b.id, article_id: a.id, article_title: a.title ?? a.original_url, heading, text: b.text, translation: b.translation,
        source: lexical && semantic ? "both" : lexical ? "lexical" : "semantic", score: lexical ? 1 : 0.82,
      });
    }
  }
  return { hits, semantic_error: null };
}

function view(id: number): ArticleView | null {
  const a = articles.find((x) => x.id === id);
  if (!a) return null;
  const summary = SUMMARIES[id];
  return {
    article: a,
    target_language: a.language === "ja" ? "en" : "ja",
    blocks: blocksOf(a),
    jobs: jobsOf(a),
    summary: summary ? { text: summary, created_at: new Date(NOW).toISOString(), stale: false } : null,
  };
}

const articleCards = (id: number) => [...cards.values()].filter((c) => c.item.article_id === id);

/** A generated quiz: one recall question per prose block of the article. */
function generateQuiz(id: number): Quiz {
  const blocks = blocksOf(article(id)).filter((b) => b.kind === "paragraph");
  return {
    id: 100 + id, created_at: new Date(NOW).toISOString(), stale: false, in_review: 0,
    questions: blocks.map((b, i) => ({ id: id * 1000 + i, kind: "recall", question: `${i + 1} 段落目の要点は？`, answer: b.text, explanation: "", block_ids: [b.id] })),
  };
}

function reviewOverview(): ReviewOverview {
  const byArticle = new Map<number, ReviewItem[]>();
  for (const { item } of cards.values()) byArticle.set(item.article_id, [...(byArticle.get(item.article_id) ?? []), item]);
  const tomorrow = NOW / 1000 + 86_400;
  return {
    due: [...cards.values()].filter((c) => c.due).length,
    next_due_at: [...cards.values()].some((c) => !c.due) ? tomorrow : null,
    articles: [...byArticle].map(([id, items]) => ({
      article_id: id, title: items[0].article_title, cards: items.length,
      next_due_at: articleCards(id).some((c) => c.due) ? NOW / 1000 : tomorrow,
    })),
  };
}

let nextId = 1000;
function addArticle(url: string, title: string | null, extra: Partial<ArticleRow> = {}): number {
  const id = nextId++;
  articles.push({
    id, original_url: url, canonical_url: null, domain: URL.parse(url)?.hostname ?? "", title, author: null, site_name: null, published_at: null,
    language: "en", saved_at: new Date(NOW).toISOString(), fetch_status: "pending", extraction_status: "pending", last_error: null,
    read_status: "unread", favorite: false, tags: [], genre: null, genre_manual: false, difficulty: null, difficulty_manual: false,
    feed_id: null, feed_title: null, thin: false, from_feed: false, pdf: false, ...extra,
  });
  return id;
}

const none = () => null;

export const handlers = {
  save_url: ({ url }: { url: string }): number => articles.find((a) => a.original_url === url)?.id ?? addArticle(url, null),
  save_page: (): number => addArticle("https://example.com/page", "Saved page"),
  reextract_article: ({ id }: { id: number }): number => id,
  render_article: none,
  get_auto_render: (): boolean => store.autoRender,
  set_auto_render: ({ on }: { on: boolean }) => void (store.autoRender = on),
  article_image: none,
  favicon: none,
  get_image_settings: (): ImageSettings => store.images,
  set_image_settings: ({ settings }: { settings: ImageSettings }) => void (store.images = settings),
  list_articles: ({ filter, sort }: { filter: ArticleFilter; sort: ArticleSort | null }): ArticleRow[] =>
    articles.filter((a) => matches(a, filter)).sort(SORTERS[sort ?? "saved_desc"]),
  list_tags: (): TagCount[] => counts(articles.flatMap((a) => a.tags)),
  set_favorite: ({ id, favorite }: { id: number; favorite: boolean }) => void (article(id).favorite = favorite),
  add_tag: ({ id, name }: { id: number; name: string }) => {
    const a = article(id);
    if (!a.tags.includes(name)) a.tags = [...a.tags, name];
  },
  remove_tag: ({ id, name }: { id: number; name: string }) => {
    const a = article(id);
    a.tags = a.tags.filter((t) => t !== name);
  },
  get_article: ({ id }: { id: number }): ArticleView | null => view(id),
  delete_article: ({ id }: { id: number }): boolean => {
    const i = articles.findIndex((a) => a.id === id);
    if (i >= 0) articles.splice(i, 1);
    return i >= 0;
  },
  translate_article: none,
  summarize_article: none,
  quiz_article: ({ id }: { id: number }) => void quizzes.set(id, generateQuiz(id)),
  get_quiz: ({ id }: { id: number }): Quiz | null => {
    const q = quizzes.get(id);
    return q ? { ...q, in_review: articleCards(id).length } : null;
  },
  review_add: ({ quizId, answers }: { quizId: number; answers: { question_id: number; grade: Grade }[] }): number => {
    const [id, quiz] = [...quizzes].find(([, q]) => q.id === quizId)!;
    const a = article(id);
    for (const q of quiz.questions) {
      if (cards.has(q.id)) continue;
      const answered = answers.some((x) => x.question_id === q.id);
      cards.set(q.id, { item: { ...q, article_id: id, article_title: a.title ?? a.original_url, new: !answered, previews: NEW_PREVIEWS }, due: !answered });
    }
    return articleCards(id).length;
  },
  review_grade: ({ questionId }: { questionId: number }) => {
    const c = cards.get(questionId);
    if (!c) throw new Error("このカードは復習から外されています");
    c.due = false;
  },
  review_remove_card: ({ questionId }: { questionId: number }) => void cards.delete(questionId),
  review_remove_article: ({ articleId }: { articleId: number }) => {
    for (const c of articleCards(articleId)) cards.delete(c.item.id);
  },
  review_queue: (): ReviewItem[] => [...cards.values()].filter((c) => c.due).map((c) => c.item),
  review_overview: reviewOverview,
  get_review_settings: (): ReviewSettings => store.review,
  set_review_settings: ({ settings }: { settings: ReviewSettings }) => {
    if (settings.min_interval_minutes < 1) throw new Error("最短間隔は 1 分〜30 日です");
    store.review = settings;
  },
  search_blocks: ({ query, filter }: { query: string; filter: ArticleFilter | null }): SearchResult => search(query, filter),
  chat_ask: ({ threadId, question, scope }: { threadId: number | null; question: string; scope: ChatScope }): ChatMessage => {
    const thread = threadId ?? Math.max(0, ...threads.map((t) => t.id)) + 1;
    if (threadId == null) threads.unshift({ id: thread, title: question, updated_at: new Date(NOW).toISOString() });
    const m: ChatMessage = {
      id: messages.length + 1, thread_id: thread, question, answer: "保存した記事には、この質問に答える記述が見つかりませんでした。", citations: [], scope,
      mode: "retrieval", provider: "claude_cli", model: null, created_at: new Date(NOW).toISOString(),
    };
    messages.push(m);
    return m;
  },
  chat_threads: () => threads,
  get_chat_budget: (): ChatBudget => store.chatBudget,
  set_chat_budget: ({ budget }: { budget: ChatBudget }) => void (store.chatBudget = budget),
  chat_messages: ({ threadId }: { threadId: number }): ChatMessage[] => messages.filter((m) => m.thread_id === threadId),
  chat_delete_thread: ({ threadId }: { threadId: number }) => {
    threads.splice(threads.findIndex((t) => t.id === threadId), 1);
  },
  set_read: ({ id, read }: { id: number; read: boolean }) => void (article(id).read_status = read ? "read" : "unread"),
  db_path: (): string => "C:\\Users\\e2e\\AppData\\Roaming\\dev.lattice.app\\lattice.db",
  get_settings: (): Settings => ({
    db_path: "C:\\Users\\e2e\\AppData\\Roaming\\dev.lattice.app\\lattice.db",
    data_dir: "C:\\Users\\e2e\\AppData\\Roaming\\dev.lattice.app",
    location: "default",
    location_warning: null,
    log_dir: "C:\\Users\\e2e\\AppData\\Local\\dev.lattice.app\\logs",
    backup_dir: "C:\\Users\\e2e\\AppData\\Roaming\\dev.lattice.app\\backups",
    backup_keep: store.backupKeep,
  }),
  get_llm_settings: (): LlmSettings => store.llm,
  set_llm_chain: ({ chain }: { chain: ChainEntry[] }) => void (store.llm = { ...store.llm, chain }),
  set_api_key: none,
  backup_db: () => ({ path: "C:\\Users\\e2e\\AppData\\Roaming\\dev.lattice.app\\backups\\lattice-20261020.db", warning: null }),
  set_backup_keep: ({ keep }: { keep: number }) => void (store.backupKeep = keep),
  import_urls: ({ text }: { text: string }) => {
    const urls = text.match(/https?:\/\/\S+/g) ?? [];
    const existing = urls.filter((u) => articles.some((a) => a.original_url === u)).length;
    for (const u of urls) if (!articles.some((a) => a.original_url === u)) addArticle(u, null);
    return { found: urls.length, queued: urls.length - existing, existing, invalid: 0 };
  },
  import_markdown: ({ text }: { text: string }): number =>
    addArticle(`local:md/${text.length}`, /^#\s+(.+)$/m.exec(text)?.[1] ?? null, { domain: "", fetch_status: "ok", extraction_status: "ok" }),
  import_markdown_file: none,
  import_pdf_file: (): number =>
    addArticle("local:pdf/e2e", "Reading Order in Two Column Papers", { domain: "", fetch_status: "ok", extraction_status: "ok", pdf: true }),
  set_unread_badge: none,
  get_taskbar_badge: (): boolean => store.taskbarBadge,
  set_taskbar_badge: ({ on }: { on: boolean }) => void (store.taskbarBadge = on),
  get_ui_language: (): string | null => store.uiLanguage,
  set_ui_language: ({ lang }: { lang: string }) => void (store.uiLanguage = lang),
  article_for_url: ({ url }: { url: string }): ArticleRow | null => articles.find((a) => a.original_url === url) ?? null,
  list_genres: (): TagCount[] => counts(articles.map((a) => a.genre)),
  set_genre: ({ id, name }: { id: number; name: string }) => {
    const a = article(id);
    a.genre = name || null;
    a.genre_manual = true;
  },
  rename_genre: ({ from, to }: { from: string; to: string }) => {
    for (const a of articles) if (a.genre === from) a.genre = to;
  },
  delete_genre: none,
  set_difficulty: ({ id, level }: { id: number; level: number | null }) => {
    const a = article(id);
    a.difficulty = level;
    a.difficulty_manual = level != null;
  },
  get_translate_keep_terms: (): boolean => store.keepTerms,
  set_translate_keep_terms: ({ on }: { on: boolean }) => void (store.keepTerms = on),
  get_translate_instructions: (): string => store.translateInstructions,
  set_translate_instructions: ({ text }: { text: string }) => void (store.translateInstructions = text),
  get_translation_prompt: (): string => "You translate English technical writing into natural Japanese. Keep code, identifiers and product names as they are.",
  get_custom_instructions: (): CustomInstructions => store.custom,
  set_custom_instructions: ({ settings }: { settings: CustomInstructions }) => void (store.custom = settings),
  classify_article: none,
  classify_unclassified: (): number => articles.filter((a) => a.genre == null).length,
  get_auto_classify: (): boolean => store.autoClassify,
  set_auto_classify: ({ on }: { on: boolean }) => void (store.autoClassify = on),
  list_feeds: () => feeds,
  add_feed: ({ url }: { url: string }): number => {
    const id = Math.max(...feeds.map((f) => f.id)) + 1;
    feeds.push({ id, url, title: null, custom_title: null, has_icon: false, site_url: null, last_fetched_at: null, last_error: null, article_count: 0 });
    return id;
  },
  discover_feeds: ({ url }: { url: string }): FeedCandidate[] => [{ url: new URL("/feed.xml", url).href, title: "Discovered feed" }],
  remove_feed: ({ id }: { id: number }) => {
    feeds.splice(feeds.findIndex((f) => f.id === id), 1);
  },
  refresh_feeds: (): number => feeds.length,
  rename_feed: ({ id, name }: { id: number; name: string | null }) => {
    const f = feeds.find((x) => x.id === id);
    if (f) f.custom_title = name?.trim() || null;
  },
  set_feed_icon: none,
  feed_icon: none,
  job_overview: () => jobs,
  retry_job: (): boolean => true,
  retry_failed_jobs: (): number => jobs.issues.filter((j) => j.status === "failed").length,
  cancel_job: (): boolean => true,
  export_json: (): string => "C:\\Users\\e2e\\AppData\\Roaming\\dev.lattice.app\\exports\\lattice-20261020.jsonl.gz",
  browser_open: none,
  browser_set_bounds: (): boolean => true,
  browser_hide: none,
  browser_close: none,
  browser_capture: none,
  browser_go: none,
  browser_set_translation: none,
  browser_set_keys: none,
  r2_status: (): R2Status => store.r2,
  r2_save: ({ settings }: { settings: R2Settings }) => {
    const { secret_access_key: secret, ...rest } = settings;
    store.r2 = { ...store.r2, ...rest, has_secret: store.r2.has_secret || !!secret };
  },
  r2_clear_secret: () => void (store.r2 = { ...store.r2, has_secret: false }),
  r2_backup_now: (): string => "lattice/2026-10-20T03-00-00Z.db.gz",
  pick_data_dir: () => null,
  set_data_dir: (): string => "C:\\Users\\e2e\\LatticeData",
  restart_app: none,
  update_info: (): UpdateInfo => ({ current: "0.1.0", configured: false, portable: false }),
  update_check: () => null,
  update_install: none,
};

export type Command = keyof typeof handlers;

/** Tauri's window and webview plugins, as the title bar and the page shortcuts use them. */
export const pluginHandlers: Record<string, () => unknown> = {
  "plugin:window|is_maximized": () => false,
  "plugin:window|minimize": none,
  "plugin:window|toggle_maximize": none,
  "plugin:window|close": none,
  "plugin:window|start_dragging": none,
  "plugin:webview|set_webview_focus": none,
};

export function handle(cmd: string, args: unknown): unknown {
  const h = (handlers as Record<string, (a: unknown) => unknown>)[cmd] ?? pluginHandlers[cmd];
  if (!h) throw new Error(`unmocked command: ${cmd}`);
  // Results cross the IPC boundary as JSON: callers never share the mock's objects.
  return structuredClone(h(args) ?? null);
}
