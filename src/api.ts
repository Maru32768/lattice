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
}

export type ArticleFilter = { kind: "all" } | { kind: "unread" } | { kind: "favorites" } | { kind: "tag"; name: string };

export interface TagCount {
  name: string;
  count: number;
}

export interface ArticleView {
  article: ArticleRow;
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

export interface ImportSummary {
  found: number;
  queued: number;
  existing: number;
  invalid: number;
}

export interface Settings {
  db_path: string;
  log_dir: string;
  backup_dir: string;
}

export type ProviderKind = "claude_cli" | "codex_cli" | "openai" | "gemini";

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
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const api = {
  saveUrl: (url: string) => invoke<number>("save_url", { url }),
  listArticles: (filter: ArticleFilter) => invoke<ArticleRow[]>("list_articles", { filter }),
  listTags: () => invoke<TagCount[]>("list_tags"),
  setFavorite: (id: number, favorite: boolean) => invoke<void>("set_favorite", { id, favorite }),
  addTag: (id: number, name: string) => invoke<void>("add_tag", { id, name }),
  removeTag: (id: number, name: string) => invoke<void>("remove_tag", { id, name }),
  getArticle: (id: number) => invoke<ArticleView | null>("get_article", { id }),
  translateArticle: (id: number) => invoke<void>("translate_article", { id }),
  summarizeArticle: (id: number) => invoke<void>("summarize_article", { id }),
  search: (query: string) => invoke<SearchResult>("search_blocks", { query }),
  setRead: (id: number, read: boolean) => invoke<void>("set_read", { id, read }),
  dbPath: () => invoke<string>("db_path"),
  settings: () => invoke<Settings>("get_settings"),
  llmSettings: () => invoke<LlmSettings>("get_llm_settings"),
  setLlmChain: (chain: ChainEntry[]) => invoke<void>("set_llm_chain", { chain }),
  setApiKey: (kind: "openai" | "gemini", key: string | null) => invoke<void>("set_api_key", { kind, key }),
  backup: () => invoke<string>("backup_db"),
  importUrls: (text: string) => invoke<ImportSummary>("import_urls", { text }),
  articleForUrl: (url: string) => invoke<ArticleRow | null>("article_for_url", { url }),
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
