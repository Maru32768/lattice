import { Fragment, useEffect, useState, type ReactNode } from "react";
import { api, r2 } from "./api";
import { ModelSettings } from "./ModelSettings";
import { TranslationSettings } from "./TranslationSettings";
import { InstructionSettings } from "./InstructionSettings";
import { ChatSettings } from "./ChatSettings";
import { ClassifySettings } from "./ClassifySettings";
import { GenreSettings } from "./GenreSettings";
import { RenderSettings } from "./RenderSettings";
import { ImageSettings } from "./ImageSettings";
import { QuizSettings } from "./QuizSettings";
import { BackupSection } from "./BackupSection";
import { R2BackupSection } from "./R2BackupSection";
import { ExportSection } from "./ExportSection";
import { StorageSection } from "./StorageSection";
import { ShortcutSettings } from "./ShortcutSettings";
import { LanguageSettings } from "./LanguageSettings";
import { BrowserSettings } from "./BrowserSettings";
import { TaskbarSettings } from "./TaskbarSettings";
import { UpdateSection } from "./Update";
import "./manage.css";
import { useT, type PlainKey, type T } from "./i18n";

export type SettingsSection = "language" | "provider" | "translation" | "instructions" | "classify" | "genres" | "render" | "images" | "review" | "shortcuts" | "browser" | "taskbar" | "backup" | "r2" | "export" | "storage" | "update";

const GROUPS = { ai: "settingsView.groupAi", library: "settingsView.groupLibrary", controls: "settingsView.groupControls", data: "settingsView.groupData", app: "settingsView.groupApp" } as const satisfies Record<string, PlainKey>;
type Group = keyof typeof GROUPS;

/** `lead` is a key, or rendered (text with markup). */
const SECTIONS: { id: SettingsSection; group: Group; title: PlainKey; lead?: PlainKey | ((t: T) => ReactNode) }[] = [
  { id: "provider", group: "ai", title: "settingsView.provider", lead: "settingsView.providerLead" },
  { id: "translation", group: "ai", title: "settingsView.translation", lead: "settingsView.translationLead" },
  { id: "instructions", group: "ai", title: "settingsView.instructions", lead: "settingsView.instructionsLead" },
  { id: "classify", group: "ai", title: "settingsView.classify" },
  { id: "genres", group: "library", title: "settingsView.genres", lead: "settingsView.genresLead" },
  { id: "render", group: "library", title: "settingsView.render" },
  { id: "images", group: "library", title: "settingsView.images" },
  { id: "review", group: "library", title: "settingsView.review", lead: "settingsView.reviewLead" },
  { id: "language", group: "controls", title: "language.title" },
  { id: "shortcuts", group: "controls", title: "settingsView.shortcuts", lead: "settingsView.shortcutsLead" },
  { id: "browser", group: "controls", title: "settingsView.browser", lead: "settingsView.browserLead" },
  { id: "taskbar", group: "controls", title: "settingsView.taskbar" },
  { id: "backup", group: "data", title: "settingsView.backup", lead: "settingsView.backupLead" },
  { id: "r2", group: "data", title: "settingsView.r2", lead: (t) => t.rich("settingsView.r2Lead", { code: <code>infra/r2</code> }) },
  { id: "export", group: "data", title: "settingsView.export" },
  { id: "storage", group: "data", title: "settingsView.storage" },
  { id: "update", group: "app", title: "settingsView.update", lead: "settingsView.updateLead" },
];

function Body({ id, onChanged, onOpenUrl }: { id: SettingsSection; onChanged: () => void; onOpenUrl: (url: string) => void }) {
  switch (id) {
    case "provider": return <ModelSettings />;
    case "translation": return <TranslationSettings />;
    case "instructions": return <><InstructionSettings /><ChatSettings /></>;
    case "classify": return <ClassifySettings />;
    case "genres": return <GenreSettings onChanged={onChanged} />;
    case "render": return <RenderSettings />;
    case "images": return <ImageSettings />;
    case "review": return <QuizSettings />;
    case "language": return <LanguageSettings />;
    case "shortcuts": return <ShortcutSettings />;
    case "browser": return <BrowserSettings />;
    case "taskbar": return <TaskbarSettings />;
    case "backup": return <BackupSection />;
    case "r2": return <R2BackupSection />;
    case "export": return <ExportSection />;
    case "storage": return <StorageSection />;
    case "update": return <UpdateSection onOpenUrl={onOpenUrl} />;
  }
}

export function SettingsView({ initialSection = "provider", onBack, onFeeds, onChanged, onOpenUrl }: {
  initialSection?: SettingsSection;
  onBack: () => void;
  onFeeds: () => void;
  onChanged: () => void;
  /** Opens a web page (release notes) in the Page view. */
  onOpenUrl: (url: string) => void;
}) {
  const t = useT();
  const [section, setSection] = useState(initialSection);
  const [badges, setBadges] = useState<Partial<Record<SettingsSection, ReactNode>>>({});

  // Re-read on every switch so a count edited in one section shows when leaving it.
  useEffect(() => {
    void Promise.allSettled([api.llmSettings(), api.listGenres(), r2.status()]).then(([llm, genres, r2s]) => setBadges({
      provider: llm.status === "fulfilled" ? t("settingsView.models", { length: llm.value.chain.length }) : null,
      genres: genres.status === "fulfilled" ? genres.value.length : null,
      r2: r2s.status === "fulfilled" && r2s.value.last_error ? <span className="error-text">{t("common.error")}</span> : null,
    }));
  }, [section, t]);

  const current = SECTIONS.find((s) => s.id === section)!;
  return (
    <div className="stg">
      <nav aria-label={t("settingsView.categories")} data-pane="nav">
        <button className="ni back" onClick={onBack}>
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
          {t("settingsView.backToLibrary")}<span className="kbd">Esc</span>
        </button>
        {(Object.keys(GROUPS) as Group[]).map((g) => (
          <Fragment key={g}>
            <div className="sec">{t(GROUPS[g])}</div>
            {SECTIONS.filter((s) => s.group === g).map((s) => (
              <button key={s.id} className={`ni${s.id === section ? " on" : ""}`} title={t(s.title)} aria-current={s.id === section ? "page" : undefined} onClick={() => setSection(s.id)}>
                <span className="label">{t(s.title)}</span>
                {badges[s.id] != null && <span className="n">{badges[s.id]}</span>}
              </button>
            ))}
            {g === "library" && <button className="ni" onClick={onFeeds}>{t("settingsView.feeds")}</button>}
          </Fragment>
        ))}
      </nav>
      <main key={section} data-pane="doc">
        <div className="body">
          <header>
            <div className="cap">{t(GROUPS[current.group])}</div>
            <h1>{t(current.title)}</h1>
            {current.lead && <p className="lead">{typeof current.lead === "function" ? current.lead(t) : t(current.lead)}</p>}
          </header>
          <Body id={section} onChanged={onChanged} onOpenUrl={onOpenUrl} />
        </div>
      </main>
    </div>
  );
}
