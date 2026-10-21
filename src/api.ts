import { invoke } from "@tauri-apps/api/core";
import type { PageKeys } from "./keys";
import type { Lang, T } from "./i18n/index.ts";

// Mirrors lattice-core's serde types (ir.rs / store.rs).
export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; v: string; href: string };

export type BlockKind =
  | "heading" | "paragraph" | "list_item" | "blockquote" | "code" | "table" | "image" | "caption";

export interface Block {
  id: number;
  ordinal: number;
  heading_id: number | null;
  kind: BlockKind;
  text: string;
  inlines?: Inline[];
  attrs: {
    level?: number;
    ordered?: boolean;
    depth?: number;
    lang?: string;
    src?: string;
    rows?: string[][];
  };
  translation: string | null;
}

export interface JobRow {
  id: number;
  type: string;
  article_id: number | null;
  params: string | null;
  status: "pending" | "running" | "succeeded" | "failed";
  attempt_count: number;
  last_error: string | null;
  next_run_at: string | null;
}

export interface ArticleRow {
  id: number;
  /** `local:md/<hash>` / `local:pdf/<hash>` for an imported Markdown or PDF file (see `isLocal`). */
  original_url: string;
  canonical_url: string | null;
  domain: string;
  title: string | null;
  author: string | null;
  site_name: string | null;
  published_at: string | null;
  language: string | null;
  saved_at: string;
  fetch_status: "pending" | "ok" | "failed";
  extraction_status: "pending" | "ok" | "failed";
  last_error: string | null;
  read_status: "unread" | "read";
  favorite: boolean;
  tags: string[];
  /** Ids of the groups the article is in (`GroupRow`). */
  groups: number[];
  genre: string | null;
  genre_manual: boolean;
  /** 1 (入門) to 5 (専門); see DifficultyField.tsx. */
  difficulty: number | null;
  difficulty_manual: boolean;
  feed_id: number | null;
  feed_title: string | null;
  /** Extracted, but almost no text: probably rendered by JS. Re-save it from the browser. */
  thin: boolean;
  /** The text is the feed entry's copy: the page was refused or empty (`last_error` says why). */
  from_feed: boolean;
  /** Extracted from a PDF (a URL's or an imported file's); there is no HTML page to render. */
  pdf: boolean;
  /** Importance for the reader, 1-5, judged against the 「自分について」 profile (relevance.rs), and why. */
  relevance: number | null;
  relevance_reason: string | null;
  /** Judged against an earlier profile. */
  relevance_stale: boolean;
}

/** An imported file (Markdown or PDF): no page to open, refetch or render. */
export const isLocal = (url: string) => url.startsWith("local:");

/** The site shown for an article: its domain, or "local" for an imported file. */
export const siteOf = (a: Pick<ArticleRow, "domain">, t: T) => a.domain || t("common.local");

/** `genre` null: 未分類; `feed` null: 手動追加; `important`: importance at least `min`. */
export type ArticleFilter =
  | { kind: "all" } | { kind: "unread" } | { kind: "favorites" } | { kind: "tag"; name: string }
  | { kind: "genre"; name: string | null } | { kind: "feed"; id: number | null } | { kind: "group"; id: number } | { kind: "important"; min: number };

export type ArticleSort = "saved_desc" | "saved_asc" | "published_desc" | "difficulty_asc" | "relevance_desc";

/** Mirrors relevance.rs Status. */
export interface RelevanceStatus {
  has_profile: boolean;
  auto: boolean;
  /** The lowest score in 重要. */
  threshold: number;
  scored: number;
  /** Judged against an earlier profile. */
  stale: number;
  unscored: number;
}

export interface FeedRow {
  id: number;
  url: string;
  /** The feed's own title; see `feedName`. */
  title: string | null;
  /** The user's name for the feed, shown in place of `title`. */
  custom_title: string | null;
  /** The user picked an icon (`api.feedIcon`), shown in place of the site's favicon. */
  has_icon: boolean;
  site_url: string | null;
  last_fetched_at: string | null;
  last_error: string | null;
  article_count: number;
  /** Entries the import filters kept out (`api.feedRejected`). */
  rejected: number;
  /** The feed has import filters of its own. */
  filtered: boolean;
  /** Why the LLM filter last let entries through unjudged (a coded message). */
  filter_note: string | null;
}

/** Mirrors feed_filter.rs. */
export type FilterField = "title" | "url" | "author" | "category" | "domain" | "language";
export interface FilterRule {
  field: FilterField;
  action: "include" | "exclude";
  pattern: string;
  regex: boolean;
}

/** One import filter: the global defaults (feedId null) or a feed's own. */
export interface FeedFilter {
  rules: FilterRule[];
  /** Entries whose feed carries their full text need at least this many characters of it. */
  min_chars: number | null;
  llm: boolean;
  instruction: string;
  /** Import only entries the LLM rates at least this relevant to 「自分について」 (1-5). */
  min_relevance: number | null;
}

export type FilterScope = "global" | "feed";
export type FilterReason =
  | { kind: "excluded"; scope: FilterScope; rule: FilterRule }
  | { kind: "not_included"; scope: FilterScope }
  | { kind: "too_short"; scope: FilterScope; min: number; chars: number }
  | { kind: "llm"; reason: string; score: number | null };

export interface RejectedEntry {
  /** Normalized; the key for `api.importRejected`. */
  url: string;
  title: string | null;
  published_at: string | null;
  excerpt: string;
  reason: FilterReason | null;
}

export interface Reevaluated {
  imported: number;
  /** Passed the rules and wait for the LLM. */
  asked: number;
  rejected: number;
}

export interface FeedCandidate {
  url: string;
  title: string | null;
}

/** A user-made collection of articles (G53); an article can be in many. */
export interface GroupRow {
  id: number;
  name: string;
  created_at: string;
  count: number;
}

export interface TagCount {
  name: string;
  count: number;
}

export interface ArticleView {
  article: ArticleRow;
  /** Language of `blocks[].translation`: Japanese articles are translated into English. */
  target_language: "ja" | "en";
  blocks: Block[];
  jobs: JobRow[];
  summary: { text: string; created_at: string; stale: boolean } | null;
}

export interface SearchHit {
  block_id: number;
  article_id: number;
  article_title: string;
  heading: string | null;
  text: string;
  translation: string | null;
  source: "lexical" | "semantic" | "both";
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  semantic_error: string | null;
}

/** Mirrors chat.rs. Every article filter is a chat scope. */
export type ChatScope = { kind: "article"; id: number } | { kind: "filter"; filter: ArticleFilter };
/** How much of the scope one chat question sends (`chat::Budget`). */
export type ChatBudget = "small" | "standard" | "large";

export interface Citation {
  n: number;
  block_id: number;
  article_id: number;
  url: string;
  title: string;
  heading: string | null;
  text: string;
}

export interface ChatMessage {
  id: number;
  thread_id: number;
  question: string;
  answer: string;
  citations: Citation[];
  scope: ChatScope;
  mode: "full" | "retrieval" | "none";
  provider: string | null;
  model: string | null;
  created_at: string;
}

export interface ChatThread {
  id: number;
  title: string;
  updated_at: string;
}

export interface ImportSummary {
  found: number;
  queued: number;
  existing: number;
  invalid: number;
  /** The articles the valid URLs are, new and already saved. */
  ids: number[];
}

export interface ImageSettings {
  save: boolean;
  /** Per-image size cap in MB. */
  max_mb: number;
}

export interface Settings {
  db_path: string;
  /** The folder with the database, backups, exports and the search model. */
  data_dir: string;
  /** default: %APPDATA%; custom: chosen in settings; portable: `data` next to the exe. */
  location: "default" | "custom" | "portable";
  /** Why the chosen folder is not in use (the default folder is used instead). */
  location_warning: string | null;
  log_dir: string;
  backup_dir: string;
  backup_keep: number;
}

/** Mirrors lattice-core's backup::LocalBackup. */
export interface LocalBackup {
  path: string;
  /** The backup was written but deleting old generations failed. */
  warning: string | null;
}

export type ProviderKind = "claude_cli" | "codex_cli" | "openai" | "gemini" | "anthropic";

/** The user's context for summaries and chat answers; blank means none. */
export interface CustomInstructions {
  profile: string;
  summary: string;
  chat: string;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChainEntry {
  kind: ProviderKind;
  model: string | null;
  /** Absent or null: the provider's default. */
  effort?: Effort | null;
}

/** Where an API key comes from; the key itself never reaches the UI. */
export type KeySource = "stored" | "env" | null;

export interface LlmSettings {
  chain: ChainEntry[];
  openai_key: KeySource;
  gemini_key: KeySource;
  anthropic_key: KeySource;
}

/** Mirrors lattice-core's job_status.rs. */
export type JobState = "pending" | "backoff" | "running" | "failed";

export interface JobCount {
  job_type: string;
  state: JobState;
  count: number;
}

export interface JobIssue {
  id: number;
  job_type: string;
  article_id: number | null;
  article_title: string | null;
  status: "pending" | "failed";
  attempt_count: number;
  last_error: string | null;
  next_run_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface JobOverview {
  counts: JobCount[];
  issues: JobIssue[];
}

/** Mirrors lattice-core's quiz.rs / srs.rs. A question's id is also its review card's id. */
export type Grade = "again" | "hard" | "good" | "easy";

export type QuizQuestion = {
  id: number;
  question: string;
  answer: string;
  explanation: string;
  /** Blocks the answer comes from. */
  block_ids: number[];
} & ({ kind: "recall" } | { kind: "choice"; options: string[] });

export interface Quiz {
  id: number;
  questions: QuizQuestion[];
  created_at: string;
  /** The article's text or the 「自分について」 profile changed since generation. */
  stale: boolean;
  /** Cards in review from this article. */
  in_review: number;
}

/** Mirrors review.rs Item: today's queue holds quiz questions and vocabulary cards. */
export type ReviewItem = QuizReviewItem | VocabReviewItem;

export type QuizReviewItem = QuizQuestion & {
  type: "quiz";
  article_id: number;
  article_title: string;
  /** Never answered. */
  new: boolean;
  /** Minutes until the next review after again / hard / good / easy. */
  previews: [number, number, number, number];
};

export interface ReviewOverview {
  /** Cards in today's queue now. */
  due: number;
  /** Unix seconds. */
  next_due_at: number | null;
  articles: { article_id: number; title: string; cards: number; next_due_at: number }[];
}

/** Mirrors lattice-core's vocab.rs. */
export interface VocabSense {
  headword: string;
  pos: string;
  /** Japanese, as used in the first capture. */
  meaning: string;
  definition: string;
  ipa: string;
  example: string;
}

/** Where a word was captured. */
export interface VocabContext {
  surface: string;
  sentence: string;
  article_id: number | null;
  block_id: number | null;
  url: string | null;
  title: string | null;
}

export interface VocabEntry extends VocabSense {
  id: number;
  /** pending: waiting for the LLM; failed: it gave no usable answer. */
  state: "pending" | "ready" | "failed";
  suspended: boolean;
  created_at: string;
  /** Unix seconds; null before the word has a meaning. */
  due_at: number | null;
  contexts: VocabContext[];
}

export interface VocabCapture {
  surface: string;
  sentence: string;
  article_id?: number | null;
  block_id?: number | null;
  url?: string | null;
}

export type VocabReviewItem = VocabSense & {
  type: "vocab";
  /** The card's id. */
  id: number;
  entry_id: number;
  kind: "cloze" | "meaning";
  context: VocabContext;
  new: boolean;
  previews: [number, number, number, number];
};

export interface ReviewSettings {
  new_per_day: number;
  reviews_per_day: number;
  min_interval_minutes: number;
  max_interval_days: number;
}

/** Mirrors browser.rs OverlayLabels: the in-page overlay's tooltip text. */
export interface OverlayLabels {
  original: string;
  translated: string;
  flip: string;
  translating: string;
  failed: string;
  retry: string;
  save_word: string;
  saved_word: string;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const api = {
  saveUrl: (url: string) => invoke<number>("save_url", { url }),
  /** Saves the page a browser tab (by its webview key) shows, as rendered. */
  savePage: (tab: string) => invoke<number>("save_page", { tab }),
  reextractArticle: (id: number) => invoke<number>("reextract_article", { id }),
  /** Re-saves the article from its page as rendered in a hidden webview (background job). */
  renderArticle: (id: number) => invoke<void>("render_article", { id }),
  autoRender: () => invoke<boolean>("get_auto_render"),
  setAutoRender: (on: boolean) => invoke<void>("set_auto_render", { on }),
  /** The stored image of an image block as a data: URL; null while not downloaded or not stored. */
  articleImage: (blockId: number) => invoke<string | null>("article_image", { blockId }),
  /** A site's icon as a data: URL; null while not fetched (a fetch is queued; `favicon-changed` follows) or when it has none. */
  favicon: (domain: string) => invoke<string | null>("favicon", { domain }),
  imageSettings: () => invoke<ImageSettings>("get_image_settings"),
  setImageSettings: (settings: ImageSettings) => invoke<void>("set_image_settings", { settings }),
  listArticles: (filter: ArticleFilter, sort?: ArticleSort) => invoke<ArticleRow[]>("list_articles", { filter, sort: sort ?? null }),
  listTags: () => invoke<TagCount[]>("list_tags"),
  setFavorite: (id: number, favorite: boolean) => invoke<void>("set_favorite", { id, favorite }),
  addTag: (id: number, name: string) => invoke<void>("add_tag", { id, name }),
  removeTag: (id: number, name: string) => invoke<void>("remove_tag", { id, name }),
  listGroups: () => invoke<GroupRow[]>("list_groups"),
  createGroup: (name: string) => invoke<number>("create_group", { name }),
  renameGroup: (id: number, name: string) => invoke<void>("rename_group", { id, name }),
  /** The group's articles stay in the library. */
  deleteGroup: (id: number) => invoke<void>("delete_group", { id }),
  groupAdd: (id: number, articles: number[]) => invoke<void>("group_add", { id, articles }),
  groupRemove: (id: number, articles: number[]) => invoke<void>("group_remove", { id, articles }),
  getArticle: (id: number) => invoke<ArticleView | null>("get_article", { id }),
  /** Removes the article with its HTML, blocks, translations only it uses, summaries, images and jobs. */
  deleteArticle: (id: number) => invoke<boolean>("delete_article", { id }),
  translateArticle: (id: number) => invoke<void>("translate_article", { id }),
  /** Drops the article's translations for its current target and translates every block again. */
  retranslateArticle: (id: number) => invoke<void>("translate_article", { id, fresh: true }),
  summarizeArticle: (id: number) => invoke<void>("summarize_article", { id }),
  /** Queues the quiz job (generate, or regenerate). */
  quizArticle: (id: number) => invoke<void>("quiz_article", { id }),
  /** The article's newest quiz. */
  quiz: (id: number) => invoke<Quiz | null>("get_quiz", { id }),
  /** Adds the quiz's questions to review; `answers` count as their first review. Returns the article's cards in review. */
  reviewAdd: (quizId: number, answers: { question_id: number; grade: Grade }[]) => invoke<number>("review_add", { quizId, answers }),
  reviewGrade: (questionId: number, grade: Grade) => invoke<void>("review_grade", { questionId, grade }),
  reviewRemoveCard: (questionId: number) => invoke<void>("review_remove_card", { questionId }),
  reviewRemoveArticle: (articleId: number) => invoke<void>("review_remove_article", { articleId }),
  /** Today's cards, within the daily limits. */
  reviewQueue: () => invoke<ReviewItem[]>("review_queue"),
  reviewOverview: () => invoke<ReviewOverview>("review_overview"),
  reviewSettings: () => invoke<ReviewSettings>("get_review_settings"),
  setReviewSettings: (settings: ReviewSettings) => invoke<void>("set_review_settings", { settings }),
  vocabAdd: (capture: VocabCapture) => invoke<{ entry_id: number; new: boolean }>("vocab_add", { capture }),
  vocabList: () => invoke<VocabEntry[]>("vocab_list"),
  vocabSetMeaning: (id: number, meaning: string) => invoke<void>("vocab_set_meaning", { id, meaning }),
  vocabSuspend: (id: number, suspended: boolean) => invoke<void>("vocab_suspend", { id, suspended }),
  vocabDelete: (id: number) => invoke<void>("vocab_delete", { id }),
  /** Asks the LLM again about a failed word. */
  vocabRetry: (id: number) => invoke<void>("vocab_retry", { id }),
  vocabGrade: (cardId: number, grade: Grade) => invoke<void>("vocab_grade", { cardId, grade }),
  /** Writes an Anki-importable CSV into the exports folder; returns its path. */
  exportVocabCsv: () => invoke<string>("export_vocab_csv"),
  search: (query: string, filter?: ArticleFilter) => invoke<SearchResult>("search_blocks", { query, filter: filter ?? null }),
  chatAsk: (threadId: number | null, question: string, scope: ChatScope) =>
    invoke<ChatMessage>("chat_ask", { threadId, question, scope }),
  chatThreads: () => invoke<ChatThread[]>("chat_threads"),
  chatMessages: (threadId: number) => invoke<ChatMessage[]>("chat_messages", { threadId }),
  chatDeleteThread: (threadId: number) => invoke<void>("chat_delete_thread", { threadId }),
  chatBudget: () => invoke<ChatBudget>("get_chat_budget"),
  setChatBudget: (budget: ChatBudget) => invoke<void>("set_chat_budget", { budget }),
  setRead: (id: number, read: boolean) => invoke<void>("set_read", { id, read }),
  dbPath: () => invoke<string>("db_path"),
  settings: () => invoke<Settings>("get_settings"),
  llmSettings: () => invoke<LlmSettings>("get_llm_settings"),
  setLlmChain: (chain: ChainEntry[]) => invoke<void>("set_llm_chain", { chain }),
  setApiKey: (kind: "openai" | "gemini" | "anthropic", key: string | null) => invoke<void>("set_api_key", { kind, key }),
  backup: () => invoke<LocalBackup>("backup_db"),
  /** Native folder picker; null when cancelled. `has_data`: the folder already holds a Lattice database. */
  pickDataDir: () => invoke<{ path: string; has_data: boolean } | null>("pick_data_dir"),
  /** Uses the picked folder from the next start, copying the current data there or switching to the data in it. */
  setDataDir: (copy: boolean) => invoke<string>("set_data_dir", { copy }),
  restart: () => invoke<void>("restart_app"),
  setBackupKeep: (keep: number) => invoke<void>("set_backup_keep", { keep }),
  importUrls: (text: string) => invoke<ImportSummary>("import_urls", { text }),
  /** Imports Markdown as an article; the same text again returns the existing one. */
  importMarkdown: (text: string) => invoke<number>("import_markdown", { text }),
  /** Opens a file dialog (in the backend); null when cancelled. */
  importMarkdownFile: () => invoke<number | null>("import_markdown_file"),
  /** Opens a PDF file dialog (in the backend); null when cancelled. */
  importPdfFile: () => invoke<number | null>("import_pdf_file"),
  /** The unread count for the taskbar badge (shown unless switched off). */
  setUnreadBadge: (count: number) => invoke<void>("set_unread_badge", { count }),
  taskbarBadge: () => invoke<boolean>("get_taskbar_badge"),
  setTaskbarBadge: (on: boolean) => invoke<void>("set_taskbar_badge", { on }),
  /** The display language; null until the UI first stores the one it detected. */
  uiLanguage: () => invoke<Lang | null>("get_ui_language"),
  setUiLanguage: (lang: Lang) => invoke<void>("set_ui_language", { lang }),
  articleForUrl: (url: string) => invoke<ArticleRow | null>("article_for_url", { url }),
  listGenres: () => invoke<TagCount[]>("list_genres"),
  setGenre: (id: number, name: string) => invoke<void>("set_genre", { id, name }),
  renameGenre: (from: string, to: string) => invoke<void>("rename_genre", { from, to }),
  deleteGenre: (name: string) => invoke<void>("delete_genre", { name }),
  setDifficulty: (id: number, level: number | null) => invoke<void>("set_difficulty", { id, level }),
  translateKeepTerms: () => invoke<boolean>("get_translate_keep_terms"),
  setTranslateKeepTerms: (on: boolean) => invoke<void>("set_translate_keep_terms", { on }),
  translateInstructions: () => invoke<string>("get_translate_instructions"),
  setTranslateInstructions: (text: string) => invoke<void>("set_translate_instructions", { text }),
  /** The built-in translation prompt (English to Japanese, current term mode) that the instructions extend. */
  translationPrompt: () => invoke<string>("get_translation_prompt"),
  customInstructions: () => invoke<CustomInstructions>("get_custom_instructions"),
  setCustomInstructions: (settings: CustomInstructions) => invoke<void>("set_custom_instructions", { settings }),
  classifyArticle: (id: number) => invoke<void>("classify_article", { id }),
  classifyUnclassified: () => invoke<number>("classify_unclassified"),
  autoClassify: () => invoke<boolean>("get_auto_classify"),
  setAutoClassify: (on: boolean) => invoke<void>("set_auto_classify", { on }),
  relevanceStatus: () => invoke<RelevanceStatus>("relevance_status"),
  setAutoRelevance: (on: boolean) => invoke<void>("set_auto_relevance", { on }),
  setRelevanceThreshold: (min: number) => invoke<void>("set_relevance_threshold", { min }),
  /** The given articles, or (null) every article whose score is missing or stale. Returns how many were queued. */
  rescoreRelevance: (ids: number[] | null) => invoke<number>("rescore_relevance", { ids }),
  listFeeds: () => invoke<FeedRow[]>("list_feeds"),
  addFeed: (url: string) => invoke<number>("add_feed", { url }),
  discoverFeeds: (url: string) => invoke<FeedCandidate[]>("discover_feeds", { url }),
  removeFeed: (id: number) => invoke<void>("remove_feed", { id }),
  refreshFeeds: () => invoke<number>("refresh_feeds"),
  /** null or blank goes back to the feed's own title. */
  renameFeed: (id: number, name: string | null) => invoke<void>("rename_feed", { id, name }),
  /** Image bytes (PNG, JPEG, GIF, WebP, ICO or SVG, 1 MB at most), or null for the site's favicon. */
  setFeedIcon: (id: number, bytes: number[] | null) => invoke<void>("set_feed_icon", { id, bytes }),
  /** The user's icon for a feed as a data: URL; null when it has none. */
  feedIcon: (id: number) => invoke<string | null>("feed_icon", { id }),
  /** feedId null: the global defaults. */
  feedFilter: (feedId: number | null) => invoke<FeedFilter>("get_feed_filter", { feedId }),
  setFeedFilter: (feedId: number | null, filter: FeedFilter) => invoke<void>("set_feed_filter", { feedId, filter }),
  feedRejected: (feedId: number) => invoke<RejectedEntry[]>("feed_rejected", { feedId }),
  /** Returns how many articles were queued (0 when it was saved already). */
  importRejected: (feedId: number, url: string) => invoke<number>("import_rejected", { feedId, url }),
  /** One feed's rejected entries, or (null) every feed's, through the current filters. */
  reevaluateRejected: (feedId: number | null) => invoke<Reevaluated>("reevaluate_rejected", { feedId }),
  jobOverview: () => invoke<JobOverview>("job_overview"),
  retryJob: (id: number) => invoke<boolean>("retry_job", { id }),
  retryFailedJobs: (jobType: string | null) => invoke<number>("retry_failed_jobs", { jobType }),
  cancelJob: (id: number) => invoke<boolean>("cancel_job", { id }),
  /** Writes a JSON-lines export and returns its path. */
  /** `group`: only that group's articles. */
  exportJson: (group: number | null = null) => invoke<string>("export_json", { group }),
};

/**
 * The in-app browser: one native child webview per visible Page tab, positioned over its placeholder
 * element in whichever window calls. `tab` is the tab's webview key (`PageTab.key`).
 */
export const browser = {
  open: (tab: string, url: string, bounds: Bounds, focusText?: string) =>
    invoke<void>("browser_open", { tab, url, bounds, focusText: focusText ?? null }),
  /** Also shows the webview, in the calling window. False when the tab has none (evicted or restored): open it again. */
  setBounds: (tab: string, bounds: Bounds) => invoke<boolean>("browser_set_bounds", { tab, bounds }),
  hide: (tab: string) => invoke<void>("browser_hide", { tab }),
  close: (tab: string) => invoke<void>("browser_close", { tab }),
  /** PNG data URL of the page as drawn (Windows); null elsewhere. */
  capture: (tab: string) => invoke<string | null>("browser_capture", { tab }),
  go: (tab: string, action: "back" | "forward" | "reload") => invoke<void>("browser_go", { tab, action }),
  setTranslation: (enabled: boolean, percent: number, labels: OverlayLabels) => invoke<void>("browser_set_translation", { enabled, percent, labels }),
  setKeys: (keys: PageKeys) => invoke<void>("browser_set_keys", { keys }),
};

/** Mirrors lattice-core's r2::R2Status. Secret values never reach the UI, only `has_secret`. */
export interface R2Status {
  enabled: boolean;
  account_id: string;
  bucket: string;
  access_key_id: string;
  interval_hours: number;
  keep_generations: number;
  has_secret: boolean;
  last_success: number | null;
  last_key: string | null;
  last_error: string | null;
  /** The last upload succeeded but deleting old generations failed. */
  last_prune_error: string | null;
  running: boolean;
}

export interface R2Settings {
  enabled: boolean;
  account_id: string;
  bucket: string;
  access_key_id: string;
  interval_hours: number;
  keep_generations: number;
  /** null or empty keeps the stored secret. */
  secret_access_key: string | null;
}

/** Automatic backup to Cloudflare R2. */
export const r2 = {
  status: () => invoke<R2Status>("r2_status"),
  save: (settings: R2Settings) => invoke<void>("r2_save", { settings }),
  clearSecret: () => invoke<void>("r2_clear_secret"),
  backupNow: () => invoke<string>("r2_backup_now"),
};

export interface UpdateInfo {
  current: string;
  /** false while tauri.conf.json still has the placeholder public key (docs/release.md). */
  configured: boolean;
  /** Portable copies are updated by replacing them with the new zip, not by the installer. */
  portable: boolean;
}

/** In-place updates from the GitHub releases. */
export const updates = {
  info: () => invoke<UpdateInfo>("update_info"),
  /** The newer version, or null when this one is the latest. */
  check: () => invoke<string | null>("update_check"),
  /** Downloads and installs, then the app restarts; `update-progress` events report the download. */
  install: () => invoke<void>("update_install"),
};
