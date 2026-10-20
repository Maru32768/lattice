import { Fragment, useEffect, useState, type ReactNode } from "react";
import { api, r2 } from "./api";
import { ModelSettings } from "./ModelSettings";
import { TranslationSettings } from "./TranslationSettings";
import { InstructionSettings } from "./InstructionSettings";
import { ClassifySettings } from "./ClassifySettings";
import { GenreSettings } from "./GenreSettings";
import { RenderSettings } from "./RenderSettings";
import { ImageSettings } from "./ImageSettings";
import { BackupSection } from "./BackupSection";
import { R2BackupSection } from "./R2BackupSection";
import { ExportSection } from "./ExportSection";
import { StorageSection } from "./StorageSection";
import { ShortcutSettings } from "./ShortcutSettings";
import { BrowserSettings } from "./BrowserSettings";
import { TaskbarSettings } from "./TaskbarSettings";
import "./manage.css";

export type SettingsSection = "provider" | "translation" | "instructions" | "classify" | "genres" | "render" | "images" | "shortcuts" | "browser" | "taskbar" | "backup" | "r2" | "export" | "storage";

const GROUPS = ["AI", "ライブラリ", "操作", "データ"] as const;

const SECTIONS: { id: SettingsSection; group: (typeof GROUPS)[number]; title: string; lead?: ReactNode }[] = [
  { id: "provider", group: "AI", title: "AI プロバイダ", lead: "翻訳・要約・分類・対話で使うモデル。上から順に使い、usage limit やエラーで失敗したら次の段に切り替えます（失敗した段は 5 分間後回し）。" },
  { id: "translation", group: "AI", title: "翻訳", lead: "記事の翻訳とページ表示の翻訳の両方に効きます。" },
  { id: "instructions", group: "AI", title: "要約・対話", lead: "要約と対話の回答に、あなたの関心や前提知識を反映させます。記事の本文は信頼しない入力として扱い、その中の指示には従わせません。" },
  { id: "classify", group: "AI", title: "自動分類" },
  { id: "genres", group: "ライブラリ", title: "ジャンル", lead: "名前を既存のジャンル名に変えると、そのジャンルに統合します（記事を移動。Reader で選んだジャンルは手動のまま固定されます）。記事のないジャンルは削除できます。自動分類は次回から新しい名前を使います。" },
  { id: "render", group: "ライブラリ", title: "取り込み・JS 描画" },
  { id: "images", group: "ライブラリ", title: "画像" },
  { id: "shortcuts", group: "操作", title: "ショートカット", lead: "キーボードの操作。キーを追加するとそのキーを記録します（修飾キーとの組み合わせも可）。" },
  { id: "browser", group: "操作", title: "ブラウザ", lead: "ページ表示（アプリ内ブラウザ）の URL バーとホームボタン。" },
  { id: "taskbar", group: "操作", title: "タスクバー" },
  { id: "backup", group: "データ", title: "バックアップ", lead: "記事・訳・要約・画像・検索 index など、すべてのデータは 1 つの SQLite ファイルにあり、バックアップはそのファイルのコピーです（場所は「ログ・保存場所」）。" },
  { id: "r2", group: "データ", title: "クラウドバックアップ（R2）", lead: <>DB のコピー（API キーは除く）を gzip 圧縮して Cloudflare R2 にアップロードします。アップロードに成功するたびに、この端末のバックアップを新しいものから指定した世代数だけ残して古いものを削除します（日数では消さないので、しばらく使わなくても消えません）。bucket は <code>infra/r2</code> の Terraform で管理します。</> },
  { id: "export", group: "データ", title: "エクスポート" },
  { id: "storage", group: "データ", title: "ログ・保存場所" },
];

function Body({ id, onChanged }: { id: SettingsSection; onChanged: () => void }) {
  switch (id) {
    case "provider": return <ModelSettings />;
    case "translation": return <TranslationSettings />;
    case "instructions": return <InstructionSettings />;
    case "classify": return <ClassifySettings />;
    case "genres": return <GenreSettings onChanged={onChanged} />;
    case "render": return <RenderSettings />;
    case "images": return <ImageSettings />;
    case "shortcuts": return <ShortcutSettings />;
    case "browser": return <BrowserSettings />;
    case "taskbar": return <TaskbarSettings />;
    case "backup": return <BackupSection />;
    case "r2": return <R2BackupSection />;
    case "export": return <ExportSection />;
    case "storage": return <StorageSection />;
  }
}

export function SettingsView({ initialSection = "provider", onBack, onFeeds, onChanged }: {
  initialSection?: SettingsSection;
  onBack: () => void;
  onFeeds: () => void;
  onChanged: () => void;
}) {
  const [section, setSection] = useState(initialSection);
  const [badges, setBadges] = useState<Partial<Record<SettingsSection, ReactNode>>>({});

  // Re-read on every switch so a count edited in one section shows when leaving it.
  useEffect(() => {
    Promise.allSettled([api.llmSettings(), api.listGenres(), r2.status()]).then(([llm, genres, r2s]) => setBadges({
      provider: llm.status === "fulfilled" ? `${llm.value.chain.length} 段` : null,
      genres: genres.status === "fulfilled" ? genres.value.length : null,
      r2: r2s.status === "fulfilled" && r2s.value.last_error ? <span className="error-text">エラー</span> : null,
    }));
  }, [section]);

  const current = SECTIONS.find((s) => s.id === section)!;
  return (
    <div className="stg">
      <nav aria-label="設定カテゴリ" data-pane="nav">
        <button className="ni back" onClick={onBack}>
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
          ライブラリに戻る<span className="kbd">Esc</span>
        </button>
        {GROUPS.map((g) => (
          <Fragment key={g}>
            <div className="sec">{g}</div>
            {SECTIONS.filter((s) => s.group === g).map((s) => (
              <button key={s.id} className={`ni${s.id === section ? " on" : ""}`} title={s.title} aria-current={s.id === section ? "page" : undefined} onClick={() => setSection(s.id)}>
                <span className="label">{s.title}</span>
                {badges[s.id] != null && <span className="n">{badges[s.id]}</span>}
              </button>
            ))}
            {g === "ライブラリ" && <button className="ni" onClick={onFeeds}>フィード →</button>}
          </Fragment>
        ))}
      </nav>
      <main key={section} data-pane="doc">
        <div className="body">
          <header>
            <div className="cap">{current.group}</div>
            <h1>{current.title}</h1>
            {current.lead && <p className="lead">{current.lead}</p>}
          </header>
          <Body id={section} onChanged={onChanged} />
        </div>
      </main>
    </div>
  );
}
