import type { ProviderKind } from "../api";
import { EFFORTS, PROVIDERS, type EntryChoice, presets } from "../settings/providers";
import { Menu, type MenuItem } from "../ui/Popover";
import { Icon } from "../ui/Icon";
import { useT } from "../i18n";

/** The model a conversation asks; null is the AI provider chain in Settings. */
export type Choice = EntryChoice | null;

/** The button beside the send button: it shows the AI the conversation asks and opens a menu of every provider's models and its efforts. */
export function ModelMenu({ choice, onChange }: { choice: Choice; onChange: (c: Choice) => void }) {
  const t = useT();
  // Another provider starts on its own defaults: its efforts are not the same set.
  const pick = (kind: ProviderKind, model: string, custom: boolean): EntryChoice => {
    const same = choice?.kind === kind;
    return { kind, model: custom ? (same ? choice.model : "") : model, custom, effort: same ? choice.effort : "" };
  };
  const providers: MenuItem[] = PROVIDERS.map((p) => {
    const on = choice?.kind === p.value ? choice : null;
    return {
      label: p.label,
      checked: on != null,
      onSelect: () => {},
      items: [
        ...presets(t)[p.value].map((m) => ({
          label: m.label,
          checked: !!on && !on.custom && on.model === m.value,
          onSelect: () => onChange(pick(p.value, m.value, false)),
        })),
        { label: t("modelSettings.other"), checked: !!on?.custom, onSelect: () => onChange(pick(p.value, "", true)) },
      ],
    };
  });
  // The provider chain in Settings sets each entry's own effort.
  const effort: (MenuItem | string)[] = choice
    ? [
        "-",
        {
          label: `effort: ${choice.effort || t(EFFORTS[choice.kind].label)}`,
          checked: false,
          onSelect: () => {},
          items: [
            { label: t(EFFORTS[choice.kind].label), checked: choice.effort === "", onSelect: () => onChange({ ...choice, effort: "" }) },
            ...EFFORTS[choice.kind].values.map((v) => ({ label: v, checked: choice.effort === v, onSelect: () => onChange({ ...choice, effort: v }) })),
          ],
        },
      ]
    : [];
  const shown = choice
    ? [PROVIDERS.find((p) => p.value === choice.kind)?.label, choice.model.trim(), choice.effort].filter(Boolean).join(" · ")
    : t("chatPane.llmDefaultShort");
  return (
    <Menu
      className="llm-btn"
      label={t("chatPane.llmLabel")}
      title={`${t("chatPane.llmLabel")}: ${shown}`}
      align="right"
      trigger={
        <>
          <span className="opt-l">{shown}</span>
          <Icon name="down" size="sm" />
        </>
      }
      items={[t("chatPane.llmCaption"), { label: t("chatPane.llmDefault"), checked: choice == null, onSelect: () => onChange(null) }, ...providers, ...effort]}
    />
  );
}
