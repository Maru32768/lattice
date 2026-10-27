import type { ProviderHealth } from "../api";
import { relTime } from "../lib/time";
import { useT } from "../i18n";

const NAMES: Record<string, string> = {
  "claude-cli": "Claude CLI",
  "codex-cli": "Codex CLI",
  "openai-api": "OpenAI API",
  "gemini-api": "Gemini API",
  "anthropic-api": "Anthropic API",
};

/**
 * The chain steps whose last call failed. When a later step answers, the failure shows nowhere else
 * (only in the log), so 処理状況 and 設定 › AI プロバイダ both list them.
 */
export function ProviderHealthNotice({ health }: { health: ProviderHealth[] }) {
  const t = useT();
  const failing = health.filter((h) => h.error != null);
  if (failing.length === 0) {
    return null;
  }
  return (
    <div className="card provider-health" role="alert">
      {failing.map((h, i) => (
        <div key={i}>
          <div className="ph-h">
            {t("providerHealth.failed", {
              provider: NAMES[h.provider] ?? h.provider,
              model: h.model ?? t("providerHealth.defaultModel"),
              // "N seconds ago" without reading the clock in render: that long before the epoch, seen from the epoch.
              when: relTime(new Date(-(h.failed_secs_ago ?? 0) * 1000).toISOString(), t, 0),
            })}
          </div>
          <div className="ph-e mono">{h.error}</div>
          <div className="ph-d muted">{h.cooling ? t("providerHealth.cooling") : t("providerHealth.retrying")}</div>
        </div>
      ))}
    </div>
  );
}
