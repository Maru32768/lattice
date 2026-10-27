import { invoke } from "@tauri-apps/api/core";
import type { PageKeys } from "./lib/keys";
import type { DragStart, WindowGeom } from "./layout/tabDrag";
import type { Lang, T } from "./i18n/index.ts";

import type {
  ArticleFilter,
  ArticleRow,
  ArticleSort,
  ArticleView,
  Bounds,
  ChainEntry,
  ChatBudget,
  ChatMessage,
  ChatScope,
  ChatThread,
  CustomInstructions,
  FeedCandidate,
  FeedFilter,
  FeedRow,
  FolderRow,
  Grade,
  GroupRow,
  ImageSettings,
  ImportSummary,
  JobCount,
  JobOverview,
  LlmSettings,
  LocalBackup,
  NetworkSettings,
  OpmlFeed,
  OverlayLabels,
  PickedDir,
  Quiz,
  R2Settings,
  R2Status,
  Reevaluated,
  RejectedEntry,
  RelevanceStatus,
  ReviewAnswer,
  ReviewItem,
  ReviewOverview,
  ReviewSettings,
  SearchResult,
  Settings,
  TagCount,
  UpdateInfo,
  VocabAdded,
  VocabCapture,
  VocabEntry,
} from "./bindings";
export type * from "./bindings";

/** Where an API key comes from; the key itself never reaches the UI. */
export type KeySource = LlmSettings["openai_key"];
export type JobState = JobCount["state"];

/** An imported file (Markdown or PDF): no page to open, refetch or render. */
export const isLocal = (url: string) => url.startsWith("local:");

/** The site shown for an article: its domain, or "local" for an imported file. */
export const siteOf = (a: Pick<ArticleRow, "domain">, t: T) => a.domain || t("common.local");

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
  networkSettings: () => invoke<NetworkSettings>("get_network_settings"),
  setNetworkSettings: (settings: NetworkSettings) => invoke<void>("set_network_settings", { settings }),
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
  reviewAdd: (quizId: number, answers: ReviewAnswer[]) => invoke<number>("review_add", { quizId, answers }),
  reviewGrade: (questionId: number, grade: Grade) => invoke<void>("review_grade", { questionId, grade }),
  reviewRemoveCard: (questionId: number) => invoke<void>("review_remove_card", { questionId }),
  reviewRemoveArticle: (articleId: number) => invoke<void>("review_remove_article", { articleId }),
  /** Today's cards, within the daily limits. */
  reviewQueue: () => invoke<ReviewItem[]>("review_queue"),
  reviewOverview: () => invoke<ReviewOverview>("review_overview"),
  reviewSettings: () => invoke<ReviewSettings>("get_review_settings"),
  setReviewSettings: (settings: ReviewSettings) => invoke<void>("set_review_settings", { settings }),
  vocabAdd: (capture: VocabCapture) => invoke<VocabAdded>("vocab_add", { capture }),
  vocabList: () => invoke<VocabEntry[]>("vocab_list"),
  vocabSetMeaning: (id: number, meaning: string) => invoke<void>("vocab_set_meaning", { id, meaning }),
  vocabSuspend: (id: number, suspended: boolean) => invoke<void>("vocab_suspend", { id, suspended }),
  vocabDelete: (id: number) => invoke<void>("vocab_delete", { id }),
  /** Asks the LLM again about a failed word. */
  vocabRetry: (id: number) => invoke<void>("vocab_retry", { id }),
  vocabGrade: (cardId: number, grade: Grade) => invoke<void>("vocab_grade", { cardId, grade }),
  /** Writes an Anki-importable CSV into the exports folder; returns its path. */
  exportVocabCsv: () => invoke<string>("export_vocab_csv"),
  search: (query: string, articles: number[]) => invoke<SearchResult>("search_blocks", { query, articles }),
  chatAsk: (threadId: number | null, question: string, scope: ChatScope) => invoke<ChatMessage>("chat_ask", { threadId, question, scope }),
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
  pickDataDir: () => invoke<PickedDir | null>("pick_data_dir"),
  openDataDir: () => invoke<void>("open_data_dir"),
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
  /** Whether Windows launches the app at sign-in (read from the OS, not the DB). */
  autostart: () => invoke<boolean>("get_autostart"),
  setAutostart: (on: boolean) => invoke<void>("set_autostart", { on }),
  /** The display language; null until the UI first stores the one it detected. */
  uiLanguage: () => invoke<Lang | null>("get_ui_language"),
  setUiLanguage: (lang: Lang) => invoke<void>("set_ui_language", { lang }),
  articleForUrl: (url: string) => invoke<ArticleRow | null>("article_for_url", { url }),
  listGenres: () => invoke<TagCount[]>("list_genres"),
  setGenre: (id: number, name: string) => invoke<void>("set_genre", { id, name }),
  renameGenre: (from: string, to: string) => invoke<void>("rename_genre", { from, to }),
  addGenre: (name: string) => invoke<void>("add_genre", { name }),
  deleteGenre: (name: string) => invoke<void>("delete_genre", { name }),
  setArticleNote: (id: number, body: string) => invoke<void>("set_article_note", { id, body }),
  setDifficulty: (id: number, level: number | null) => invoke<void>("set_difficulty", { id, level }),
  translateKeepTerms: () => invoke<boolean>("get_translate_keep_terms"),
  setTranslateKeepTerms: (on: boolean) => invoke<void>("set_translate_keep_terms", { on }),
  /** 保存した記事を自動で翻訳 (off by default). */
  autoTranslate: () => invoke<boolean>("get_auto_translate"),
  setAutoTranslate: (on: boolean) => invoke<void>("set_auto_translate", { on }),
  translateParallel: () => invoke<number>("get_translate_parallel"),
  setTranslateParallel: (n: number) => invoke<void>("set_translate_parallel", { n }),
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
  /** `folder` puts the feed in it, new or already subscribed. */
  addFeed: (url: string, folder: number | null = null) => invoke<number>("add_feed", { url, folder }),
  listFeedFolders: () => invoke<FolderRow[]>("list_feed_folders"),
  createFeedFolder: (name: string) => invoke<number>("create_feed_folder", { name }),
  renameFeedFolder: (id: number, name: string) => invoke<void>("rename_feed_folder", { id, name }),
  /** Its feeds stay, without a folder. */
  deleteFeedFolder: (id: number) => invoke<void>("delete_feed_folder", { id }),
  reorderFeedFolders: (ids: number[]) => invoke<void>("reorder_feed_folders", { ids }),
  /** `ids` first in `folder` (null: the feeds in none), in this order, moved there from any other folder (H26). */
  reorderFeeds: (folder: number | null, ids: number[]) => invoke<void>("reorder_feeds", { folder, ids }),
  /** `folder` null takes the feeds out of their folders; moved ones go last there. */
  moveFeedsToFolder: (feeds: number[], folder: number | null) => invoke<void>("move_feeds_to_folder", { feeds, folder }),
  /** The feeds of an OPML file with their folders (created by name); subscribing is `addFeed`'s. */
  importOpml: (xml: string) => invoke<OpmlFeed[]>("import_opml", { xml }),
  /** Writes <data>/exports/lattice-feeds-<UTC>.opml and returns its path. */
  exportOpml: () => invoke<string>("export_opml"),
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
  open: (tab: string, url: string, bounds: Bounds, focusText?: string) => invoke<void>("browser_open", { tab, url, bounds, focusText: focusText ?? null }),
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

/**
 * Pop-out windows (G52): `open` also brings an open one to the front; `close` closes the calling
 * pop-out. A pop-out is created hidden and shown once it says `ready` (its UI has mounted).
 */
export const windows = {
  open: (label: string) => invoke<void>("open_window", { label }),
  close: () => invoke<void>("close_window"),
  ready: () => invoke<void>("window_ready"),
};

/** Tab drags across windows, which the backend runs (design-review §26, `src/layout/tabDrag.ts`). */
export const tabDrag = {
  start: (start: DragStart) => invoke<void>("tab_drag_start", { start }),
  /** This window's strips, while a drag is on. */
  strips: (geom: WindowGeom) => invoke<void>("tab_drag_strips", { geom }),
  /** The dragged tab was torn off into new document window `label` (its layout stored): the backend creates and places it. */
  float: (label: string) => invoke<void>("tab_drag_float", { label }),
  /** The button came up, or Escape (`cancel`: the tab goes back). */
  release: (cancel: boolean) => invoke<void>("tab_drag_release", { cancel }),
};

/** Automatic backup to Cloudflare R2. */
export const r2 = {
  status: () => invoke<R2Status>("r2_status"),
  save: (settings: R2Settings) => invoke<void>("r2_save", { settings }),
  clearSecret: () => invoke<void>("r2_clear_secret"),
  backupNow: () => invoke<string>("r2_backup_now"),
};

/** In-place updates from the GitHub releases. */
export const updates = {
  info: () => invoke<UpdateInfo>("update_info"),
  /** The newer version, or null when this one is the latest. */
  check: () => invoke<string | null>("update_check"),
  /** Downloads and installs, then the app restarts; `update-progress` events report the download. */
  install: () => invoke<void>("update_install"),
};
