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
}

export interface ArticleView {
  article: ArticleRow;
  blocks: Block[];
}

export const api = {
  saveUrl: (url: string) => invoke<number>("save_url", { url }),
  listArticles: () => invoke<ArticleRow[]>("list_articles"),
  getArticle: (id: number) => invoke<ArticleView | null>("get_article", { id }),
  setRead: (id: number, read: boolean) => invoke<void>("set_read", { id, read }),
  dbPath: () => invoke<string>("db_path"),
};
