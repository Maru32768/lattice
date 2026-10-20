import { invoke } from "@tauri-apps/api/core";

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
  genre: string | null;
  genre_manual: boolean;
  /** 1 (入門) to 5 (専門); see DifficultyField.tsx. */
  difficulty: number | null;
  difficulty_manual: boolean;
  feed_id: number | null;
  feed_title: string | null;
  /** Extracted, but almost no text: probably rendered by JS. Re-save it from the browser. */
  thin: boolean;
}

/** `genre` null: 未分類; `feed` null: 手動追加. */
export type ArticleFilter =
  | { kind: "all" } | { kind: "unread" } | { kind: "favorites" } | { kind: "tag"; name: string }
  | { kind: "genre"; name: string | null } | { kind: "feed"; id: number | null };

export type ArticleSort = "saved_desc" | "saved_asc" | "published_desc" | "difficulty_asc";

export interface FeedRow {
  id: number;
  url: string;
  title: string | null;
  site_url: string | null;
  last_fetched_at: string | null;
  last_error: string | null;
  article_count: number;
}

export interface FeedCandidate {
  url: string;
  title: string | null;
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
}

export interface ImageSettings {
  save: boolean;
  /** Per-image size cap in MB. */
  max_mb: number;
}

export interface Settings {
  db_path: string;
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

export interface ChainEntry {
  kind: ProviderKind;
  model: string | null;
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

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const api = {
  saveUrl: (url: string) => invoke<number>("save_url", { url }),
  /** Saves the page shown in the in-app browser, as rendered. */
  savePage: () => invoke<number>("save_page"),
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
  getArticle: (id: number) => invoke<ArticleView | null>("get_article", { id }),
  /** Removes the article with its HTML, blocks, translations only it uses, summaries, images and jobs. */
  deleteArticle: (id: number) => invoke<boolean>("delete_article", { id }),
  translateArticle: (id: number) => invoke<void>("translate_article", { id }),
  summarizeArticle: (id: number) => invoke<void>("summarize_article", { id }),
  search: (query: string, filter?: ArticleFilter) => invoke<SearchResult>("search_blocks", { query, filter: filter ?? null }),
  chatAsk: (threadId: number | null, question: string, scope: ChatScope) =>
    invoke<ChatMessage>("chat_ask", { threadId, question, scope }),
  chatThreads: () => invoke<ChatThread[]>("chat_threads"),
  chatMessages: (threadId: number) => invoke<ChatMessage[]>("chat_messages", { threadId }),
  chatDeleteThread: (threadId: number) => invoke<void>("chat_delete_thread", { threadId }),
  setRead: (id: number, read: boolean) => invoke<void>("set_read", { id, read }),
  dbPath: () => invoke<string>("db_path"),
  settings: () => invoke<Settings>("get_settings"),
  llmSettings: () => invoke<LlmSettings>("get_llm_settings"),
  setLlmChain: (chain: ChainEntry[]) => invoke<void>("set_llm_chain", { chain }),
  setApiKey: (kind: "openai" | "gemini" | "anthropic", key: string | null) => invoke<void>("set_api_key", { kind, key }),
  backup: () => invoke<LocalBackup>("backup_db"),
  setBackupKeep: (keep: number) => invoke<void>("set_backup_keep", { keep }),
  importUrls: (text: string) => invoke<ImportSummary>("import_urls", { text }),
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
  classifyArticle: (id: number) => invoke<void>("classify_article", { id }),
  classifyUnclassified: () => invoke<number>("classify_unclassified"),
  autoClassify: () => invoke<boolean>("get_auto_classify"),
  setAutoClassify: (on: boolean) => invoke<void>("set_auto_classify", { on }),
  listFeeds: () => invoke<FeedRow[]>("list_feeds"),
  addFeed: (url: string) => invoke<number>("add_feed", { url }),
  discoverFeeds: (url: string) => invoke<FeedCandidate[]>("discover_feeds", { url }),
  removeFeed: (id: number) => invoke<void>("remove_feed", { id }),
  refreshFeeds: () => invoke<number>("refresh_feeds"),
  jobOverview: () => invoke<JobOverview>("job_overview"),
  retryJob: (id: number) => invoke<boolean>("retry_job", { id }),
  retryFailedJobs: (jobType: string | null) => invoke<number>("retry_failed_jobs", { jobType }),
  cancelJob: (id: number) => invoke<boolean>("cancel_job", { id }),
  /** Writes a JSON-lines export and returns its path. */
  exportJson: () => invoke<string>("export_json"),
};

/** The in-app browser (a native child webview positioned over a placeholder element). */
export const browser = {
  open: (url: string, bounds: Bounds, focusText?: string) =>
    invoke<void>("browser_open", { url, bounds, focusText: focusText ?? null }),
  setBounds: (bounds: Bounds) => invoke<void>("browser_set_bounds", { bounds }),
  hide: () => invoke<void>("browser_hide"),
  go: (action: "back" | "forward" | "reload") => invoke<void>("browser_go", { action }),
  setTranslation: (enabled: boolean, percent: number) => invoke<void>("browser_set_translation", { enabled, percent }),
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
