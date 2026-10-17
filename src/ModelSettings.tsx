import { useEffect, useState } from "react";
import { api, type ChainEntry, type KeySource, type LlmSettings, type ProviderKind } from "./api";
import { SetRow } from "./SetRow";

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

const KEYS = { openai: ["OpenAI", "OPENAI_API_KEY"], gemini: ["Gemini", "GEMINI_API_KEY"], anthropic: ["Anthropic", "ANTHROPIC_API_KEY"] } as const;

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

function keyLabel(source: KeySource, env: string) {
  return source === "stored" ? "DB に保存済み" : source === "env" ? `環境変数 ${env} から` : "未設定 · 環境変数なし";
}

function KeyPill({ kind, llm }: { kind: ProviderKind; llm: LlmSettings | null }) {
  if (kind === "claude_cli" || kind === "codex_cli") return <span className="pill cli"><i />CLI ログインを使用</span>;
  const source = llm?.[`${kind}_key`] ?? null;
  return <span className={`pill${source ? "" : " off"}`}><i />キー: {source === "stored" ? "DB" : source === "env" ? "環境変数" : "未設定"}</span>;
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

  const remove = (i: number) => setSlots((prev) => [...prev.filter((_, j) => j !== i), EMPTY]);

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
    <>
      <section className="card" aria-label="Fallback chain">
        <div className="chain-head">Fallback chain<span>最大 3 段</span></div>
        {slots.map((s, i) => (
          <div className="chain" key={i}>
            <span className="k">{i + 1}</span>
            <select className="select" value={s.kind} onChange={(e) => update(i, { kind: e.target.value as ProviderKind | "", model: "", custom: false })} aria-label={`${i + 1} 段目のプロバイダ`}>
              {i > 0 && <option value="">なし</option>}
              {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
            <span className="model">
              {s.kind && (
                <select
                  className="select"
                  value={s.custom ? CUSTOM : s.model}
                  onChange={(e) => update(i, e.target.value === CUSTOM ? { custom: true } : { model: e.target.value, custom: false })}
                  aria-label={`${i + 1} 段目のモデル`}
                >
                  {PRESETS[s.kind].map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  <option value={CUSTOM}>その他（モデル ID を入力）</option>
                </select>
              )}
              {s.kind && s.custom && (
                <input className="input sm mono" value={s.model} onChange={(e) => update(i, { model: e.target.value })} placeholder="モデル ID" aria-label={`${i + 1} 段目のモデル ID`} spellCheck={false} />
              )}
            </span>
            <span>{s.kind && <KeyPill kind={s.kind} llm={llm} />}</span>
            <span>
              {s.kind && (
                <button className="btn ghost" onClick={() => remove(i)} disabled={chain.length <= 1} aria-label={`${i + 1} 段目を削除`}>削除</button>
              )}
            </span>
          </div>
        ))}
      </section>
      <div className="btn-row">
        <button className="btn pri" onClick={() => run(() => api.setLlmChain(chain), "モデルを保存しました")}>保存</button>
        <span className="muted">Claude CLI と Codex CLI は各 CLI のログインを使います。大量に翻訳するなら速いモデルがおすすめです。</span>
      </div>

      <section aria-labelledby="api-keys">
        <h2 id="api-keys">API キー</h2>
        <p className="sec-d">キーはローカルの DB に保存し、バックアップには含めません。未設定なら環境変数 <code>OPENAI_API_KEY</code> / <code>GEMINI_API_KEY</code> / <code>ANTHROPIC_API_KEY</code> を使います。値は表示しません。</p>
        <div className="grp">
          {(["openai", "gemini", "anthropic"] as const).map((kind) => {
            const source = llm?.[`${kind}_key`] ?? null;
            const [label, env] = KEYS[kind];
            return (
              <SetRow key={kind} title={label} desc={keyLabel(source, env)}>
                <input
                  className="input sm"
                  type="password"
                  value={keys[kind]}
                  onChange={(e) => setKeys((k) => ({ ...k, [kind]: e.target.value }))}
                  placeholder={source === "stored" ? "新しいキーで置き換える" : `${label} API キー`}
                  aria-label={`${label} API キー`}
                  autoComplete="off"
                />
                <button
                  className="btn"
                  disabled={!keys[kind].trim()}
                  onClick={() => run(async () => { await api.setApiKey(kind, keys[kind]); setKeys((k) => ({ ...k, [kind]: "" })); }, `${label} API キーを保存しました`)}
                >
                  保存
                </button>
                <button className="btn ghost" disabled={source !== "stored"} onClick={() => run(() => api.setApiKey(kind, null), `${label} API キーを削除しました`)} aria-label={`${label} API キーを削除`}>削除</button>
              </SetRow>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="untrusted">
        <h2 id="untrusted">記事本文の扱い</h2>
        <div className="grp">
          <SetRow title="本文は untrusted input として渡す" desc="どの adapter にも tool を渡さない。CLI は tool・MCP・設定を無効にし、空の作業ディレクトリで実行する。">
            <span className="muted">常に有効</span>
          </SetRow>
        </div>
      </section>
      {status && <p role="status" className="msg">{status}</p>}
      {error && <p role="alert" className="msg error-text">{error}</p>}
    </>
  );
}
