import type { ReactNode } from "react";
import type { PlainKey, T } from "../i18n";

// Kept apart from SettingsView so the palette can list the sections without loading the settings chunk.

export type SettingsSection =
  | "provider"
  | "profile"
  | "render"
  | "feedFilter"
  | "images"
  | "translation"
  | "instructions"
  | "browser"
  | "classify"
  | "relevance"
  | "review"
  | "language"
  | "shortcuts"
  | "taskbar"
  | "update"
  | "backup"
  | "r2"
  | "export"
  | "storage";

/** By the task a setting serves, as the guide's chapters run; AI holds only what every AI feature uses. */
export const GROUPS = {
  ai: "settingsView.groupAi",
  collect: "settingsView.groupCollect",
  read: "settingsView.groupRead",
  organize: "settingsView.groupOrganize",
  learn: "nav.learn",
  app: "settingsView.groupApp",
  data: "settingsView.groupData",
} as const satisfies Record<string, PlainKey>;
export type Group = keyof typeof GROUPS;

/** In display order; `lead` is a key, or rendered (text with markup). */
export const SECTIONS: { id: SettingsSection; group: Group; title: PlainKey; lead?: PlainKey | ((t: T) => ReactNode) }[] = [
  { id: "provider", group: "ai", title: "settingsView.provider", lead: "settingsView.providerLead" },
  { id: "profile", group: "ai", title: "instructionSettings.profile", lead: "settingsView.profileLead" },
  { id: "render", group: "collect", title: "settingsView.render" },
  { id: "feedFilter", group: "collect", title: "settingsView.feedFilter", lead: "settingsView.feedFilterLead" },
  { id: "images", group: "collect", title: "settingsView.images" },
  { id: "translation", group: "read", title: "settingsView.translation", lead: "settingsView.translationLead" },
  { id: "instructions", group: "read", title: "settingsView.instructions", lead: "settingsView.instructionsLead" },
  { id: "browser", group: "read", title: "settingsView.browser", lead: "settingsView.browserLead" },
  { id: "classify", group: "organize", title: "settingsView.classify" },
  { id: "relevance", group: "organize", title: "settingsView.relevance", lead: "settingsView.relevanceLead" },
  { id: "review", group: "learn", title: "settingsView.review", lead: "settingsView.reviewLead" },
  { id: "language", group: "app", title: "language.title" },
  { id: "shortcuts", group: "app", title: "settingsView.shortcuts", lead: "settingsView.shortcutsLead" },
  { id: "taskbar", group: "app", title: "settingsView.taskbar" },
  { id: "update", group: "app", title: "settingsView.update", lead: "settingsView.updateLead" },
  { id: "backup", group: "data", title: "settingsView.backup", lead: "settingsView.backupLead" },
  { id: "r2", group: "data", title: "settingsView.r2", lead: (t) => t.rich("settingsView.r2Lead", { code: <code>infra/r2</code> }) },
  { id: "export", group: "data", title: "settingsView.export" },
  { id: "storage", group: "data", title: "settingsView.storage" },
];
