import { useEffect, useState } from "react";
import { SetRow } from "./SetRow";
import { api, type ChatBudget } from "./api";

// Sizes mirror `chat::Budget::limits` (context characters per question).
const BUDGETS: { id: ChatBudget; label: string }[] = [
  { id: "small", label: "少なめ（約 4 万字）" },
  { id: "standard", label: "標準（約 8 万字）" },
  { id: "large", label: "多め（約 15 万字）" },
];

export function ChatSettings() {
  const [budget, setBudget] = useState<ChatBudget>("standard");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.chatBudget().then(setBudget).catch((e) => setError(String(e))); }, []);

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
      <SetRow title="対話で使う範囲" htmlFor="chat-budget"
        desc="1 回の質問で LLM に渡す記事の量。範囲が収まれば全文を、収まらなければ検索で選んだ箇所を 1 記事 4 箇所までにして多くの記事から集めます。多いほど網羅的に答えられますが、1 回のコスト（API の料金や CLI の usage）と待ち時間が増えます。次の質問から効きます。">
        <select id="chat-budget" className="select" value={budget} onChange={(e) => void save(e.target.value as ChatBudget)}>
          {BUDGETS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
      </SetRow>
      {error && <p className="msg error-text" role="alert">{error}</p>}
    </div>
  );
}
