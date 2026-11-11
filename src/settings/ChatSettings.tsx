import { useEffect, useState } from "react";
import { SetRow } from "../ui/SetRow";
import { api, type ChatBudget } from "../api";
import { SEND_KEYS, setSendKey, useSendKey, type SendKey } from "../chat/sendKey";
import { useT, type PlainKey } from "../i18n";

// Sizes mirror `chat::Budget::limits` (context characters per question).
const BUDGETS: { id: ChatBudget; label: PlainKey }[] = [
  { id: "small", label: "chatSettings.small" },
  { id: "standard", label: "chatSettings.standard" },
  { id: "large", label: "chatSettings.large" },
];

const SEND_LABELS: Record<SendKey, PlainKey> = {
  ctrlEnter: "chatSettings.sendCtrlEnter",
  enter: "chatSettings.sendEnter",
  enterOneLine: "chatSettings.sendEnterOneLine",
};

export function ChatSettings() {
  const t = useT();
  const sendKey = useSendKey();
  const [budget, setBudget] = useState<ChatBudget>("standard");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .chatBudget()
      .then(setBudget)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  async function save(b: ChatBudget) {
    setBudget(b);
    setError(null);
    try {
      await api.setChatBudget(b);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="grp">
      <SetRow title={t("chatSettings.budget")} htmlFor="chat-budget" desc={t("chatSettings.budgetDesc")}>
        <select id="chat-budget" className="select" value={budget} onChange={(e) => void save(e.target.value as ChatBudget)}>
          {BUDGETS.map((b) => (
            <option key={b.id} value={b.id}>
              {t(b.label)}
            </option>
          ))}
        </select>
      </SetRow>
      <SetRow title={t("chatSettings.sendKey")} htmlFor="chat-send-key" desc={t("chatSettings.sendKeyDesc")}>
        <select id="chat-send-key" className="select" value={sendKey} onChange={(e) => setSendKey(e.target.value as SendKey)}>
          {SEND_KEYS.map((k) => (
            <option key={k} value={k}>
              {t(SEND_LABELS[k])}
            </option>
          ))}
        </select>
      </SetRow>
      {error && (
        <p className="msg error-text" role="alert">
          {t.msg(error)}
        </p>
      )}
    </div>
  );
}
