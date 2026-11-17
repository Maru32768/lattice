import type { ChainEntry, Effort, ProviderKind } from "../api";
import { translatorFor, type PlainKey, type T } from "../i18n";

export const PROVIDERS: { value: ProviderKind; label: string }[] = [
  { value: "claude_cli", label: "Claude CLI" },
  { value: "codex_cli", label: "Codex CLI" },
  { value: "openai", label: "OpenAI API" },
  { value: "gemini", label: "Gemini API" },
  { value: "anthropic", label: "Anthropic API" },
];

// "" = the provider's default. API defaults mirror DEFAULT_MODEL in openai.rs / gemini.rs / anthropic.rs.
export const presets = (t: T): Record<ProviderKind, { value: string; label: string }[]> => ({
  claude_cli: [
    { value: "", label: t("modelSettings.cliDefault") },
    { value: "haiku", label: t("modelSettings.haiku") },
    { value: "sonnet", label: t("modelSettings.sonnet") },
    { value: "opus", label: t("modelSettings.opus") },
  ],
  codex_cli: [
    { value: "", label: t("modelSettings.cliDefault") },
    { value: "gpt-6-luna", label: t("modelSettings.luna") },
    { value: "gpt-6.1-sol", label: t("modelSettings.sol") },
    { value: "gpt-6-astra", label: t("modelSettings.astra") },
  ],
  openai: [
    { value: "", label: t("modelSettings.defaultOpenai") },
    { value: "gpt-6.1-sol", label: "gpt-6.1-sol" },
    { value: "gpt-6-astra", label: "gpt-6-astra" },
  ],
  gemini: [
    { value: "", label: t("modelSettings.defaultGemini") },
    { value: "gemini-pro-latest", label: "gemini-pro-latest" },
  ],
  anthropic: [
    { value: "", label: t("modelSettings.defaultAnthropic") },
    { value: "claude-sonnet-5-5", label: "claude-sonnet-5-5" },
    { value: "claude-haiku-5-5", label: t("modelSettings.claudeHaiku") },
  ],
});

/** A model ID typed in rather than picked from `presets`. Only the preset values are read, which are the same in every language. */
const isCustomModel = (kind: ProviderKind, model: string) => !presets(translatorFor("ja"))[kind].some((p) => p.value === model);

/** A chain entry as its selects show it. */
export interface EntryChoice {
  kind: ProviderKind;
  model: string;
  /** Free-text model ID; kept separately so choosing "その他" shows the input (F2). */
  custom: boolean;
  /** "" = the provider's default. */
  effort: Effort | "";
}

export const toChoice = ({ kind, model, effort }: ChainEntry): EntryChoice => ({
  kind,
  model: model ?? "",
  custom: isCustomModel(kind, model ?? ""),
  effort: effort ?? "",
});
export const toEntry = (c: EntryChoice): ChainEntry => ({ kind: c.kind, model: c.model.trim() || null, effort: c.effort || null });

// Mirrors ProviderKind::efforts in chain.rs. Codex runs at low unless set (codex.rs DEFAULT_EFFORT).
const ALL_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const EFFORTS: Record<ProviderKind, { label: PlainKey; values: Effort[] }> = {
  claude_cli: { label: "modelSettings.cliDefault", values: ALL_EFFORTS },
  codex_cli: { label: "modelSettings.defaultLow", values: ALL_EFFORTS },
  openai: { label: "modelSettings.modelDefault", values: ALL_EFFORTS },
  gemini: { label: "modelSettings.modelDefault", values: ["low", "medium", "high"] },
  anthropic: { label: "modelSettings.modelDefault", values: ALL_EFFORTS },
};

/** The model select's value for "その他": the model ID is typed in. */
export const CUSTOM = "__custom";
