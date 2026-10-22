// The mock backend: one handler per command in src/api.ts, over an in-memory copy of the
// fixtures. `commands.test.ts` fails when api.ts calls a command this table does not answer.
import type {
  ArticleFilter, ArticleRow, ArticleSort, ArticleView, ChainEntry, ChatBudget, ChatMessage, ChatScope, CustomInstructions, FeedCandidate, FeedFilter, FolderRow, GroupRow, ImageSettings, OpmlFeed,
  Reevaluated, RejectedEntry,
  Grade, LlmSettings, Quiz, QuizReviewItem, R2Settings, R2Status, RelevanceStatus, ReviewItem, ReviewOverview, ReviewSettings, SearchHit, SearchResult, Settings, TagCount, UpdateInfo,
  VocabCapture, VocabEntry, VocabReviewItem,
} from "../src/api.ts";
import { ARTICLES, CHAT_MESSAGES, CHAT_THREADS, FEEDS, FEED_FILTERS, FOLDERS, GROUPS, JOBS, NEW_PREVIEWS, NOW, QUIZ, REJECTED, REVIEW, SUMMARIES, VOCAB, blocksOf, jobsOf } from "./fixtures.ts";
import { folderTree, placeFeeds } from "../src/feeds/feedFolders.ts";

const articles = structuredClone(ARTICLES);
const feeds = structuredClone(FEEDS);
const groups = structuredClone(GROUPS);
const folders = structuredClone(FOLDERS);
/** A feed's folder, on the feed and on its articles, as the backend joins it. */
function syncFolders() {
  for (const f of feeds) f.folder = folders.find((x) => x.id === f.folder_id)?.name ?? null;
  for (const a of articles) a.folder_id = feeds.find((f) => f.id === a.feed_id)?.folder_id ?? null;
}
/** Feeds last in `into`, as the backend moves them; ones already there stay put. */
function toEnd(ids: number[], into: number | null) {
  for (const id of ids) {
    const i = feeds.findIndex((f) => f.id === id && f.folder_id !== into);
    if (i >= 0) feeds.push({ ...feeds.splice(i, 1)[0], folder_id: into });
  }
  syncFolders();
}
const folder = (id: number) => folders.find((x) => x.id === id) ?? reject("feedFolders.notFound");
function folderName(name: string, id: number | null): string {
  const n = name.trim();
  if (!n) reject("feedFolders.emptyName");
  if (folders.some((x) => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) reject("feedFolders.exists", { name: n });
  return n;
}
function createFolder(name: string): number {
  const id = Math.max(0, ...folders.map((x) => x.id)) + 1;
  folders.push({ id, name: folderName(name, null), feeds: 0 });
  return id;
}
const filters = new Map<number, FeedFilter>(Object.entries(structuredClone(FEED_FILTERS)).map(([k, v]) => [Number(k), v]));
const rejected = new Map<number, RejectedEntry[]>(Object.entries(structuredClone(REJECTED)).map(([k, v]) => [Number(k), v]));
const NO_FILTER: FeedFilter = { rules: [], min_chars: null, llm: false, instruction: "", min_relevance: null };
const threads = structuredClone(CHAT_THREADS);
const messages = structuredClone(CHAT_MESSAGES);
const jobs = structuredClone(JOBS);
/** Quizzes by article; review cards by question id (`due`: in today's queue). */
const quizzes = new Map<number, Quiz>([[1, structuredClone(QUIZ)]]);
const cards = new Map<number, { item: QuizReviewItem; due: boolean }>(REVIEW.map((r) => [r.id, { item: structuredClone(r), due: true }]));
/** The vocabulary, and its cards by id: a saved word's card, due at once, stands in for the enrichment job. */
const vocab = structuredClone(VOCAB);
const vocabCards = new Map<number, { entry_id: number; due: boolean }>([[31, { entry_id: 2, due: false }]]);
const entry = (id: number) => vocab.find((e) => e.id === id) ?? reject("vocab.gone");
const vocabItem = (id: number, c: { entry_id: number }): VocabReviewItem => {
  const { id: _, state: _s, suspended: _u, created_at: _c, due_at: _d, contexts, ...sense } = entry(c.entry_id);
  return { ...sense, type: "vocab", id, entry_id: c.entry_id, context: contexts[0], new: true, previews: NEW_PREVIEWS };
};
const dueVocab = () => [...vocabCards].filter(([, c]) => c.due && !entry(c.entry_id).suspended);
const store = {
  autoRender: true,
  autoClassify: true,
  autoRelevance: true,
  relevanceThreshold: 4,
  taskbarBadge: true,
  uiLanguage: null as string | null,
  keepTerms: true,
  autoTranslate: false,
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

/** Rejects like the backend: with its coded message (lattice-core msg.rs), which the UI translates. */
function reject(code: string, params: Record<string, unknown> = {}): never {
  throw JSON.stringify({ code, params });
}

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
    case "group": return a.groups.includes(f.id);
    case "important": return (a.relevance ?? 0) >= f.min;
    case "folder": return feeds.find((x) => x.id === a.feed_id)?.folder_id === f.id;
  }
}

const SORTERS: Record<ArticleSort, (a: ArticleRow, b: ArticleRow) => number> = {
  saved_desc: (a, b) => b.saved_at.localeCompare(a.saved_at) || b.id - a.id,
  saved_asc: (a, b) => a.saved_at.localeCompare(b.saved_at) || a.id - b.id,
  published_desc: (a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? "") || b.id - a.id,
  difficulty_asc: (a, b) => (a.difficulty ?? 9) - (b.difficulty ?? 9) || b.id - a.id,
  relevance_desc: (a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || b.saved_at.localeCompare(a.saved_at) || b.id - a.id,
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

/** Articles whose translation was queued: their view shows the job waiting. */
const translating = new Set<number>();

function view(id: number): ArticleView | null {
  const a = articles.find((x) => x.id === id);
  if (!a) return null;
  const summary = SUMMARIES[id];
  return {
    article: a,
    target_language: a.language === "ja" ? "en" : "ja",
    blocks: blocksOf(a),
    jobs: translating.has(id)
      ? [...jobsOf(a).filter((j) => j.type !== "translate"), { id: 2000 + id, type: "translate", article_id: id, params: null, status: "pending", attempt_count: 0, last_error: null, next_run_at: null }]
      : jobsOf(a),
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
  const byArticle = new Map<number, QuizReviewItem[]>();
  for (const { item } of cards.values()) byArticle.set(item.article_id, [...(byArticle.get(item.article_id) ?? []), item]);
  const tomorrow = NOW / 1000 + 86_400;
  return {
    due: [...cards.values()].filter((c) => c.due).length + dueVocab().length,
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
    read_status: "unread", favorite: false, tags: [], groups: [], genre: null, genre_manual: false, difficulty: null, difficulty_manual: false,
    feed_id: null, feed_title: null, folder_id: null, thin: false, from_feed: false, pdf: false, relevance: null, relevance_reason: null, relevance_stale: false, ...extra,
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
  list_articles: ({ filter, sort }: { filter: ArticleFilter; sort: ArticleSort | null }): ArticleRow[] => {
    syncFolders();
    return articles.filter((a) => matches(a, filter)).sort(SORTERS[sort ?? "saved_desc"]);
  },
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
  list_groups: (): GroupRow[] => groups.map((g) => ({ ...g, count: articles.filter((a) => a.groups.includes(g.id)).length }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  create_group: ({ name }: { name: string }): number => {
    const n = name.trim();
    if (!n) reject("groups.emptyName");
    if (groups.some((g) => g.name.toLowerCase() === n.toLowerCase())) reject("groups.exists", { name: n });
    const id = Math.max(0, ...groups.map((g) => g.id)) + 1;
    groups.push({ id, name: n, created_at: new Date(NOW).toISOString(), count: 0 });
    return id;
  },
  rename_group: ({ id, name }: { id: number; name: string }) => {
    const n = name.trim();
    if (groups.some((g) => g.id !== id && g.name.toLowerCase() === n.toLowerCase())) reject("groups.exists", { name: n });
    groups.find((g) => g.id === id)!.name = n;
  },
  delete_group: ({ id }: { id: number }) => {
    groups.splice(groups.findIndex((g) => g.id === id), 1);
    for (const a of articles) a.groups = a.groups.filter((g) => g !== id);
  },
  group_add: ({ id, articles: ids }: { id: number; articles: number[] }) => {
    for (const a of articles) if (ids.includes(a.id) && !a.groups.includes(id)) a.groups = [...a.groups, id].sort((x, y) => x - y);
  },
  group_remove: ({ id, articles: ids }: { id: number; articles: number[] }) => {
    for (const a of articles) if (ids.includes(a.id)) a.groups = a.groups.filter((g) => g !== id);
  },
  get_article: ({ id }: { id: number }): ArticleView | null => view(id),
  delete_article: ({ id }: { id: number }): boolean => {
    const i = articles.findIndex((a) => a.id === id);
    if (i >= 0) articles.splice(i, 1);
    return i >= 0;
  },
  translate_article: ({ id }: { id: number }) => void translating.add(id),
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
      cards.set(q.id, { item: { ...q, type: "quiz", article_id: id, article_title: a.title ?? a.original_url, new: !answered, previews: NEW_PREVIEWS }, due: !answered });
    }
    return articleCards(id).length;
  },
  review_grade: ({ questionId }: { questionId: number }) => {
    const c = cards.get(questionId);
    if (!c) reject("quiz.cardRemoved");
    c.due = false;
  },
  review_remove_card: ({ questionId }: { questionId: number }) => void cards.delete(questionId),
  review_remove_article: ({ articleId }: { articleId: number }) => {
    for (const c of articleCards(articleId)) cards.delete(c.item.id);
  },
  review_queue: (): ReviewItem[] => [...[...cards.values()].filter((c) => c.due).map((c) => c.item), ...dueVocab().map(([id, c]) => vocabItem(id, c))],
  review_overview: reviewOverview,
  get_review_settings: (): ReviewSettings => store.review,
  set_review_settings: ({ settings }: { settings: ReviewSettings }) => {
    if (settings.min_interval_minutes < 1) reject("quiz.minRange");
    store.review = settings;
  },
  vocab_add: ({ capture: c }: { capture: VocabCapture }): { entry_id: number; new: boolean } => {
    if (!/[A-Za-z]/.test(c.surface)) reject("vocab.notEnglish");
    if (!c.sentence.includes(c.surface)) reject("vocab.notInSentence");
    const a = c.article_id == null ? null : article(c.article_id);
    const context = { surface: c.surface, sentence: c.sentence, article_id: c.article_id ?? null, block_id: c.block_id ?? null, url: c.url ?? null, title: a?.title ?? null };
    const known = vocab.find((e) => [e.headword, ...e.contexts.map((x) => x.surface)].some((f) => f.toLowerCase() === c.surface.toLowerCase()));
    if (known) {
      if (!known.contexts.some((x) => x.sentence === c.sentence)) known.contexts.push(context);
      return { entry_id: known.id, new: false };
    }
    const id = Math.max(0, ...vocab.map((e) => e.id)) + 1;
    vocab.push({
      id, headword: c.surface.toLowerCase(), pos: "noun", meaning: `${c.surface} の意味`, definition: `${c.surface} is a word the mock explains.`, ipa: "",
      example: `An example sentence with ${c.surface}.`,
      state: "ready", suspended: false, created_at: new Date(NOW).toISOString(), due_at: NOW / 1000, contexts: [context],
    });
    vocabCards.set(100 + id, { entry_id: id, due: true });
    return { entry_id: id, new: true };
  },
  vocab_list: (): VocabEntry[] => [...vocab].sort((a, b) => b.id - a.id),
  vocab_set_meaning: ({ id, meaning }: { id: number; meaning: string }) => {
    if (!meaning.trim()) reject("vocab.meaningLength", { max: 300 });
    Object.assign(entry(id), { meaning: meaning.trim(), state: "ready" });
  },
  vocab_suspend: ({ id, suspended }: { id: number; suspended: boolean }) => void (entry(id).suspended = suspended),
  vocab_delete: ({ id }: { id: number }) => {
    vocab.splice(vocab.indexOf(entry(id)), 1);
    for (const [k, c] of vocabCards) if (c.entry_id === id) vocabCards.delete(k);
  },
  vocab_retry: ({ id }: { id: number }) => void (entry(id).state = "pending"),
  vocab_grade: ({ cardId }: { cardId: number }) => {
    const c = vocabCards.get(cardId);
    if (!c) reject("quiz.cardRemoved");
    c.due = false;
  },
  export_vocab_csv: (): string => "C:\\Users\\e2e\\AppData\\Roaming\\dev.lattice.app\\exports\\lattice-vocab-20261020T030000Z.csv",
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
    const ids = urls.map((u) => articles.find((a) => a.original_url === u)?.id ?? addArticle(u, null));
    return { found: urls.length, queued: urls.length - existing, existing, invalid: 0, ids };
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
  get_auto_translate: (): boolean => store.autoTranslate,
  set_auto_translate: ({ on }: { on: boolean }) => void (store.autoTranslate = on),
  get_translate_instructions: (): string => store.translateInstructions,
  set_translate_instructions: ({ text }: { text: string }) => void (store.translateInstructions = text),
  get_translation_prompt: (): string => "You translate English technical writing into natural Japanese. Keep code, identifiers and product names as they are.",
  get_custom_instructions: (): CustomInstructions => store.custom,
  set_custom_instructions: ({ settings }: { settings: CustomInstructions }) => void (store.custom = settings),
  classify_article: none,
  classify_unclassified: (): number => articles.filter((a) => a.genre == null).length,
  get_auto_classify: (): boolean => store.autoClassify,
  set_auto_classify: ({ on }: { on: boolean }) => void (store.autoClassify = on),
  relevance_status: (): RelevanceStatus => {
    const done = articles.filter((a) => a.extraction_status === "ok");
    return {
      has_profile: store.custom.profile.trim() !== "", auto: store.autoRelevance, threshold: store.relevanceThreshold,
      scored: done.filter((a) => a.relevance != null).length, stale: done.filter((a) => a.relevance_stale).length,
      unscored: done.filter((a) => a.relevance == null).length,
    };
  },
  set_auto_relevance: ({ on }: { on: boolean }) => void (store.autoRelevance = on),
  set_relevance_threshold: ({ min }: { min: number }) => void (store.relevanceThreshold = min),
  rescore_relevance: ({ ids }: { ids: number[] | null }): number => {
    if (!store.custom.profile.trim()) reject("relevance.noProfile");
    return ids?.length ?? articles.filter((a) => a.extraction_status === "ok" && (a.relevance == null || a.relevance_stale)).length;
  },
  // The backend's order: each folder's feeds in their order, then the feeds in none.
  list_feeds: () => {
    const tree = folderTree(feeds, folders, new Map());
    return [...tree.folders.flatMap((n) => n.feeds), ...tree.loose];
  },
  add_feed: ({ url, folder: into }: { url: string; folder: number | null }): number => {
    if (into != null) folder(into);
    const known = feeds.find((f) => f.url === url);
    if (known) {
      if (into != null) toEnd([known.id], into);
      return known.id;
    }
    const id = Math.max(...feeds.map((f) => f.id)) + 1;
    feeds.push({
      id, url, title: null, custom_title: null, has_icon: false, site_url: null, last_fetched_at: null, last_error: null, article_count: 0,
      rejected: 0, filtered: false, filter_note: null, folder_id: into, folder: null,
    });
    syncFolders();
    return id;
  },
  list_feed_folders: (): FolderRow[] => folders.map((x) => ({ ...x, feeds: feeds.filter((f) => f.folder_id === x.id).length })),
  create_feed_folder: ({ name }: { name: string }): number => createFolder(name),
  rename_feed_folder: ({ id, name }: { id: number; name: string }) => {
    folder(id).name = folderName(name, id);
    syncFolders();
  },
  delete_feed_folder: ({ id }: { id: number }) => {
    folders.splice(folders.findIndex((x) => x.id === id), 1);
    for (const f of feeds) if (f.folder_id === id) f.folder_id = null;
    syncFolders();
  },
  reorder_feed_folders: ({ ids }: { ids: number[] }) => {
    folders.sort((a, b) => (ids.indexOf(a.id) + 1 || Infinity) - (ids.indexOf(b.id) + 1 || Infinity));
  },
  move_feeds_to_folder: ({ feeds: ids, folder: into }: { feeds: number[]; folder: number | null }) => {
    if (into != null) folder(into);
    toEnd(ids, into);
  },
  reorder_feeds: ({ folder: into, ids }: { folder: number | null; ids: number[] }) => {
    if (into != null) folder(into);
    feeds.splice(0, feeds.length, ...placeFeeds(feeds, { folder: into, ids }));
    syncFolders();
  },
  // Outlines with xmlUrl are feeds; their innermost enclosing outline without one is the folder.
  import_opml: ({ xml }: { xml: string }): OpmlFeed[] => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) reject("feeds.badOpml", { error: "parse error" });
    const out: OpmlFeed[] = [];
    for (const o of doc.querySelectorAll("outline[xmlUrl]")) {
      const url = o.getAttribute("xmlUrl")!;
      if (out.some((x) => x.url === url)) continue;
      let p = o.parentElement;
      while (p && p.tagName === "outline" && p.hasAttribute("xmlUrl")) p = p.parentElement;
      const name = p?.tagName === "outline" ? (p.getAttribute("text") ?? p.getAttribute("title")) : null;
      const known = name ? folders.find((x) => x.name.toLowerCase() === name.trim().toLowerCase()) : undefined;
      out.push({ url, folder: name ? (known?.id ?? createFolder(name)) : null });
    }
    return out;
  },
  export_opml: (): string => "C:\\Users\\e2e\\AppData\\Roaming\\dev.lattice.app\\exports\\lattice-feeds-20261020T030000Z.opml",
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
  get_feed_filter: ({ feedId }: { feedId: number | null }): FeedFilter => filters.get(feedId ?? 0) ?? NO_FILTER,
  set_feed_filter: ({ feedId, filter }: { feedId: number | null; filter: FeedFilter }) => {
    for (const r of filter.rules.filter((x) => x.regex)) {
      try {
        RegExp(r.pattern);
      } catch (e) {
        reject("feedFilter.badRegex", { pattern: r.pattern, error: String(e) });
      }
    }
    filters.set(feedId ?? 0, { ...filter, rules: filter.rules.filter((r) => r.pattern.trim()), instruction: filter.instruction.trim() });
    const f = feeds.find((x) => x.id === feedId);
    if (f) f.filtered = true;
  },
  feed_rejected: ({ feedId }: { feedId: number }): RejectedEntry[] => rejected.get(feedId) ?? [],
  import_rejected: ({ feedId, url }: { feedId: number; url: string }): number => {
    const list = rejected.get(feedId) ?? [];
    const r = list.find((x) => x.url === url);
    if (!r) reject("feedFilter.notRejected");
    rejected.set(feedId, list.filter((x) => x !== r));
    feeds.find((x) => x.id === feedId)!.rejected -= 1;
    addArticle(url, r.title, { feed_id: feedId });
    return 1;
  },
  // An exclusion whose rule is gone imports; everything else stays rejected.
  reevaluate_rejected: ({ feedId }: { feedId: number | null }): Reevaluated => {
    const out = { imported: 0, asked: 0, rejected: 0 };
    for (const [id, list] of rejected) {
      if (feedId != null && id !== feedId) continue;
      const keep = list.filter((r) => {
        if (r.reason?.kind !== "excluded") return true;
        const rule = r.reason.rule;
        return (filters.get(r.reason.scope === "global" ? 0 : id)?.rules ?? []).some((x) => JSON.stringify(x) === JSON.stringify(rule));
      });
      for (const r of list.filter((x) => !keep.includes(x))) addArticle(r.url, r.title, { feed_id: id });
      out.imported += list.length - keep.length;
      out.rejected += keep.length;
      rejected.set(id, keep);
      feeds.find((x) => x.id === id)!.rejected = keep.length;
    }
    return out;
  },
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
  // A 1×1 PNG: the still that stands in for the page under an overlay.
  browser_capture: (): string => "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  browser_go: none,
  browser_set_translation: none,
  browser_set_keys: none,
  open_window: none,
  close_window: none,
  window_ready: none,
  tab_drag_start: none,
  tab_drag_strips: none,
  tab_drag_float: none,
  tab_drag_release: none,
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
  "plugin:window|set_focus": none,
  "plugin:window|set_title": none,
  "plugin:window|inner_position": () => ({ x: 0, y: 0 }),
  "plugin:webview|set_webview_focus": none,
};

export function handle(cmd: string, args: unknown): unknown {
  const h = (handlers as Record<string, (a: unknown) => unknown>)[cmd] ?? pluginHandlers[cmd];
  if (!h) throw new Error(`unmocked command: ${cmd}`);
  // Results cross the IPC boundary as JSON: callers never share the mock's objects.
  return structuredClone(h(args) ?? null);
}
