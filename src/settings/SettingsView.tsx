import { Fragment, useEffect, useState, type ReactNode } from "react";
import { api, r2 } from "../api";
import { ModelSettings } from "./ModelSettings";
import { TranslationSettings } from "./TranslationSettings";
import { InstructionSettings } from "./InstructionSettings";
import { SummarySettings } from "./SummarySettings";
import { ChatSettings } from "./ChatSettings";
import { ClassifySettings } from "./ClassifySettings";
import { RelevanceSettings } from "./RelevanceSettings";
import { FilterEditor } from "../feeds/FeedFilterEditor";
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
import { UpdateSection } from "../app/Update";
import "../ui/manage.css";
import { useT } from "../i18n";
import { GROUPS, SECTIONS, type Group, type SettingsSection } from "./sections";

function Body({ id, onChanged, onOpenUrl, onFeeds }: { id: SettingsSection; onChanged: () => void; onOpenUrl: (url: string) => void; onFeeds: () => void }) {
  const t = useT();
  switch (id) {
    case "provider":
      return <ModelSettings />;
    case "translation":
      return <TranslationSettings />;
    case "profile":
      return <InstructionSettings fields={["profile"]} />;
    case "instructions":
      return (
        <>
          <SummarySettings />
          <InstructionSettings fields={["summary", "chat"]} />
          <ChatSettings />
        </>
      );
    case "classify":
      return <ClassifySettings />;
    case "relevance":
      return <RelevanceSettings onChanged={onChanged} />;
    case "render":
      return <RenderSettings />;
    case "feedFilter":
      return (
        <div className="grp">
          <div className="set wide">
            <FilterEditor feedId={null} onSaved={onChanged} />
          </div>
          <div className="set">
            <div className="h">{t("settingsView.perFeedFilters")}</div>
            <div className="d">{t("settingsView.perFeedFiltersDesc")}</div>
            <div className="ctl">
              <button className="btn" onClick={onFeeds}>
                {t("nav.manageFeeds")}
              </button>
            </div>
          </div>
        </div>
      );
    case "images":
      return <ImageSettings />;
    case "review":
      return <QuizSettings />;
    case "language":
      return <LanguageSettings />;
    case "shortcuts":
      return <ShortcutSettings />;
    case "browser":
      return <BrowserSettings />;
    case "taskbar":
      return <TaskbarSettings />;
    case "backup":
      return <BackupSection />;
    case "r2":
      return <R2BackupSection />;
    case "export":
      return <ExportSection />;
    case "storage":
      return <StorageSection />;
    case "update":
      return <UpdateSection onOpenUrl={onOpenUrl} />;
  }
}

export function SettingsView({
  section,
  onSection,
  onBack,
  onFeeds,
  onChanged,
  onOpenUrl,
}: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onBack: () => void;
  onFeeds: () => void;
  onChanged: () => void;
  /** Opens a web page (release notes) in the Page view. */
  onOpenUrl: (url: string) => void;
}) {
  const t = useT();
  const [counts, setCounts] = useState<{ models?: number; r2Failed?: boolean }>({});

  // Re-read on every switch so a count edited in one section shows when leaving it.
  useEffect(() => {
    void Promise.allSettled([api.llmSettings(), r2.status()]).then(([llm, r2s]) =>
      setCounts({
        models: llm.status === "fulfilled" ? llm.value.chain.length : undefined,
        r2Failed: r2s.status === "fulfilled" && !!r2s.value.last_error,
      }),
    );
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the section is the trigger, not an input
  }, [section]);
  const badges: Partial<Record<SettingsSection, ReactNode>> = {
    provider: counts.models != null ? t("settingsView.models", { length: counts.models }) : null,
    r2: counts.r2Failed ? <span className="error-text">{t("common.error")}</span> : null,
  };

  const current = SECTIONS.find((s) => s.id === section)!;
  return (
    <div className="stg">
      <nav aria-label={t("settingsView.categories")} data-pane="nav">
        <button className="ni back" onClick={onBack}>
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {t("settingsView.backToLibrary")}
          <span className="kbd">Esc</span>
        </button>
        {(Object.keys(GROUPS) as Group[]).map((g) => (
          <Fragment key={g}>
            <div className="sec">{t(GROUPS[g])}</div>
            {SECTIONS.filter((s) => s.group === g).map((s) => (
              <button
                key={s.id}
                className={`ni${s.id === section ? " on" : ""}`}
                title={t(s.title)}
                aria-current={s.id === section ? "page" : undefined}
                onClick={() => onSection(s.id)}
              >
                <span className="label">{t(s.title)}</span>
                {badges[s.id] != null && <span className="n">{badges[s.id]}</span>}
              </button>
            ))}
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
          <Body id={section} onChanged={onChanged} onOpenUrl={onOpenUrl} onFeeds={onFeeds} />
        </div>
      </main>
    </div>
  );
}
