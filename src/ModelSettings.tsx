import { useEffect, useState } from "react";
import { api, type ChainEntry, type KeySource, type LlmSettings, type ProviderKind } from "./api";

const PROVIDERS: { value: ProviderKind; label: string }[] = [
  { value: "claude_cli", label: "Claude CLI" },
  { value: "codex_cli", label: "Codex CLI" },
  { value: "openai", label: "OpenAI API" },
  { value: "gemini", label: "Gemini API" },
  { value: "anthropic", label: "Anthropic API" },
];

// "" = the provider's default. API defaults mirror DEFAULT_MODEL in openai.rs / gemini.rs / anthropic.rs.
const PRESETS: Record<ProviderKind, { value: string; label: string }[]> = {
  claude_cli: [
    { value: "", label: "CLI の既定" },
    { value: "haiku", label: "Haiku（速い・安い）" },
    { value: "sonnet", label: "Sonnet（バランス）" },
    { value: "opus", label: "Opus（高品質・高コスト）" },
  ],
  codex_cli: [
    { value: "", label: "CLI の既定" },
    { value: "gpt-6-luna", label: "GPT-6-Luna（速い・安い）" },
    { value: "gpt-6.1-sol", label: "GPT-6.1-Sol（標準）" },
    { value: "gpt-6-astra", label: "GPT-6-Astra（高品質）" },
  ],
  openai: [
    { value: "", label: "既定（gpt-6-luna）" },
    { value: "gpt-6.1-sol", label: "gpt-6.1-sol" },
    { value: "gpt-6-astra", label: "gpt-6-astra" },
  ],
  gemini: [
    { value: "", label: "既定（gemini-flash-latest）" },
    { value: "gemini-pro-latest", label: "gemini-pro-latest" },
  ],
  anthropic: [
    { value: "", label: "既定（claude-opus-5-5）" },
    { value: "claude-sonnet-5-5", label: "claude-sonnet-5-5" },
    { value: "claude-haiku-5-5", label: "claude-haiku-5-5（速い・安い）" },
  ],
};

const KEY_LABELS = { openai: "OpenAI", gemini: "Gemini", anthropic: "Anthropic" } as const;

const CUSTOM = "__custom";

interface Slot {
  kind: ProviderKind | "";
  model: string;
  /** Free-text model ID; kept separately so choosing "その他" shows the input (F2). */
  custom: boolean;
}

const EMPTY: Slot = { kind: "", model: "", custom: false };

function toSlots(chain: ChainEntry[]): Slot[] {
  const slots = chain.slice(0, 3).map(({ kind, model }): Slot => {
    const m = model ?? "";
    return { kind, model: m, custom: !PRESETS[kind].some((p) => p.value === m) };
  });
  while (slots.length < 3) slots.push(EMPTY);
  return slots;
}

function keyLabel(source: KeySource) {
  return source === "stored" ? "設定済み" : source === "env" ? "環境変数から読み込み" : "未設定";
}

export function ModelSettings() {
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [slots, setSlots] = useState<Slot[]>([EMPTY, EMPTY, EMPTY]);
  const [keys, setKeys] = useState({ openai: "", gemini: "", anthropic: "" });
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const s = await api.llmSettings();
    setLlm(s);
    return s;
  }

  useEffect(() => {
    load().then((s) => setSlots(toSlots(s.chain))).catch((e) => setError(String(e)));
  }, []);

  function update(i: number, patch: Partial<Slot>) {
    setSlots((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  async function run(action: () => Promise<unknown>, done: string) {
    setError(null);
    try {
      await action();
      await load();
      setStatus(done);
    } catch (e) {
      setError(String(e));
    }
  }

  const chain: ChainEntry[] = slots.flatMap((s) => (s.kind ? [{ kind: s.kind, model: s.model.trim() || null }] : []));

  return (
    <div>
      <h3>翻訳・要約に使うモデル</h3>
      <p className="muted">上から順に使います。usage limit やエラーで失敗したら次のモデルに切り替えます（失敗したモデルは 5 分間後回し）。</p>
      {slots.map((s, i) => (
        <div className="row" key={i}>
          <span>{i + 1}.</span>
          <select value={s.kind} onChange={(e) => update(i, { kind: e.target.value as ProviderKind | "", model: "", custom: false })} aria-label={`${i + 1} 番目の provider`}>
            {i > 0 && <option value="">なし</option>}
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          {s.kind && (
            <select
              value={s.custom ? CUSTOM : s.model}
              onChange={(e) => update(i, e.target.value === CUSTOM ? { custom: true } : { model: e.target.value, custom: false })}
              aria-label={`${i + 1} 番目のモデル`}
            >
              {PRESETS[s.kind].map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              <option value={CUSTOM}>その他（モデル ID を入力）</option>
            </select>
          )}
          {s.kind && s.custom && (
            <input value={s.model} onChange={(e) => update(i, { model: e.target.value })} placeholder="モデル ID" aria-label={`${i + 1} 番目のモデル ID`} />
          )}
        </div>
      ))}
      <div className="row">
        <button onClick={() => run(() => api.setLlmChain(chain), "モデルを保存しました")}>保存</button>
      </div>
      <p className="muted">Claude CLI と Codex CLI は各 CLI のログインを使います。大量に翻訳するなら速いモデルがおすすめです。</p>

      <h3>API キー</h3>
      {(["openai", "gemini", "anthropic"] as const).map((kind) => {
        const source = llm?.[`${kind}_key`] ?? null;
        const label = KEY_LABELS[kind];
        return (
          <div className="row" key={kind}>
            <span>{label}: {keyLabel(source)}</span>
            <input
              type="password"
              value={keys[kind]}
              onChange={(e) => setKeys((k) => ({ ...k, [kind]: e.target.value }))}
              placeholder={`${label} API キー`}
              aria-label={`${label} API キー`}
              autoComplete="off"
            />
            <button
              disabled={!keys[kind].trim()}
              onClick={() => run(async () => { await api.setApiKey(kind, keys[kind]); setKeys((k) => ({ ...k, [kind]: "" })); }, `${label} API キーを保存しました`)}
            >
              保存
            </button>
            <button disabled={source !== "stored"} onClick={() => run(() => api.setApiKey(kind, null), `${label} API キーを削除しました`)}>クリア</button>
          </div>
        );
      })}
      <p className="muted">キーはローカルの DB に保存し、バックアップには含めません。未設定なら環境変数 <code>OPENAI_API_KEY</code> / <code>GEMINI_API_KEY</code> / <code>ANTHROPIC_API_KEY</code> を使います。</p>
      {status && <p role="status">{status}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </div>
  );
}
