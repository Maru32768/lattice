import { useEffect, useState } from "react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api, type ChainEntry, type Effort, type KeySource, type LlmSettings, type ProviderKind } from "../api";
import { SetRow } from "../ui/SetRow";
import { t, useT, type PlainKey, type T } from "../i18n";

const PROVIDERS: { value: ProviderKind; label: string }[] = [
  { value: "claude_cli", label: "Claude CLI" },
  { value: "codex_cli", label: "Codex CLI" },
  { value: "openai", label: "OpenAI API" },
  { value: "gemini", label: "Gemini API" },
  { value: "anthropic", label: "Anthropic API" },
];

// "" = the provider's default. API defaults mirror DEFAULT_MODEL in openai.rs / gemini.rs / anthropic.rs.
const presets = (t: T): Record<ProviderKind, { value: string; label: string }[]> => ({
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

// Mirrors ProviderKind::efforts in chain.rs. Codex runs at low unless set (codex.rs DEFAULT_EFFORT).
const ALL_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const EFFORTS: Record<ProviderKind, { label: PlainKey; values: Effort[] }> = {
  claude_cli: { label: "modelSettings.cliDefault", values: ALL_EFFORTS },
  codex_cli: { label: "modelSettings.defaultLow", values: ALL_EFFORTS },
  openai: { label: "modelSettings.modelDefault", values: ALL_EFFORTS },
  gemini: { label: "modelSettings.modelDefault", values: ["low", "medium", "high"] },
  anthropic: { label: "modelSettings.modelDefault", values: ALL_EFFORTS },
};

const KEYS = { openai: ["OpenAI", "OPENAI_API_KEY"], gemini: ["Gemini", "GEMINI_API_KEY"], anthropic: ["Anthropic", "ANTHROPIC_API_KEY"] } as const;

const CUSTOM = "__custom";

interface Slot {
  /** Stable key for drag and drop. */
  id: number;
  kind: ProviderKind | "";
  model: string;
  /** Free-text model ID; kept separately so choosing "その他" shows the input (F2). */
  custom: boolean;
  /** "" = the provider's default. */
  effort: Effort | "";
}

let nextId = 0;
const empty = (): Slot => ({ id: nextId++, kind: "", model: "", custom: false, effort: "" });

function toSlots(chain: ChainEntry[]): Slot[] {
  const slots = chain.slice(0, 3).map(({ kind, model, effort }): Slot => {
    const m = model ?? "";
    return { id: nextId++, kind, model: m, custom: !presets(t)[kind].some((p) => p.value === m), effort: effort ?? "" };
  });
  while (slots.length < 3) slots.push(empty());
  return slots;
}

const dndText = (t: T) => ({
  screenReaderInstructions: { draggable: t("modelSettings.dndHelp") },
  announcements: {
    onDragStart: () => t("modelSettings.pickedUp"),
    onDragOver: () => "",
    onDragEnd: ({ over }: { over: { id: unknown } | null }) => (over ? t("modelSettings.dropped") : t("modelSettings.moveCancelled")),
    onDragCancel: () => t("modelSettings.moveCancelled"),
  },
});

/** One fallback-chain row; the ⋮⋮ handle drags it (pointer or keyboard). Empty rows stay put. */
function ChainRow({ slot, children }: { slot: Slot; children: React.ReactNode }) {
  const t = useT();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: slot.id, disabled: !slot.kind });
  return (
    <div ref={setNodeRef} className={`chain${isDragging ? " dragging" : ""}`} style={{ transform: CSS.Translate.toString(transform), transition }}>
      {slot.kind
        ? <button ref={setActivatorNodeRef} className="grip" aria-label={t("modelSettings.drag")} title={t("modelSettings.drag")} {...attributes} {...listeners}>⋮⋮</button>
        : <span />}
      {children}
    </div>
  );
}

function keyLabel(source: KeySource, env: string) {
  return source === "stored" ? t("modelSettings.keyStored") : source === "env" ? t("modelSettings.keyFromEnv", { env }) : t("modelSettings.keyNone");
}

function KeyPill({ kind, llm }: { kind: ProviderKind; llm: LlmSettings | null }) {
  const t = useT();
  if (kind === "claude_cli" || kind === "codex_cli") return <span className="pill cli"><i />{t("modelSettings.cliLogin")}</span>;
  const source = llm?.[`${kind}_key`] ?? null;
  return <span className={`pill${source ? "" : " off"}`}><i />{t("modelSettings.keyPill", { source: source === "stored" ? "DB" : source === "env" ? t("modelSettings.envVar") : t("common.notSet") })}</span>;
}

export function ModelSettings() {
  const t = useT();
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [slots, setSlots] = useState<Slot[]>(() => [empty(), empty(), empty()]);
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
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

  const remove = (i: number) => setSlots((prev) => [...prev.filter((_, j) => j !== i), empty()]);

  function drop({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    setSlots((prev) => {
      const moved = arrayMove(prev, prev.findIndex((s) => s.id === active.id), prev.findIndex((s) => s.id === over.id));
      // Filled rows first: the first row has no "なし" option.
      return [...moved.filter((s) => s.kind), ...moved.filter((s) => !s.kind)];
    });
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

  const chain: ChainEntry[] = slots.flatMap((s) => (s.kind ? [{ kind: s.kind, model: s.model.trim() || null, effort: s.effort || null }] : []));

  return (
    <>
      <section className="card" aria-label="Fallback chain">
        <div className="chain-head">Fallback chain<span>{t("modelSettings.chainHint")}</span></div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={drop} accessibility={dndText(t)}>
          <SortableContext items={slots.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            {slots.map((s, i) => (
              <ChainRow key={s.id} slot={s}>
                <span className="k">{i + 1}</span>
                <select className="select" value={s.kind} onChange={(e) => update(i, { kind: e.target.value as ProviderKind | "", model: "", custom: false, effort: "" })} aria-label={t("modelSettings.provider", { x: i + 1 })}>
                  {i > 0 && <option value="">{t("common.none")}</option>}
                  {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
                <span className="model">
                  {s.kind && (
                    <select
                      className="select"
                      value={s.custom ? CUSTOM : s.model}
                      onChange={(e) => update(i, e.target.value === CUSTOM ? { custom: true } : { model: e.target.value, custom: false })}
                      aria-label={t("modelSettings.model", { x: i + 1 })}
                    >
                      {presets(t)[s.kind].map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      <option value={CUSTOM}>{t("modelSettings.other")}</option>
                    </select>
                  )}
                  {s.kind && s.custom && (
                    <input className="input sm mono" value={s.model} onChange={(e) => update(i, { model: e.target.value })} placeholder={t("modelSettings.modelId")} aria-label={t("modelSettings.modelIdLabel", { x: i + 1 })} spellCheck={false} />
                  )}
                  {s.kind && (
                    <select className="select effort" value={s.effort} onChange={(e) => update(i, { effort: e.target.value as Effort | "" })}
                      aria-label={t("modelSettings.effort", { x: i + 1 })} title={t("modelSettings.effortHint")}>
                      <option value="">effort: {t(EFFORTS[s.kind].label)}</option>
                      {EFFORTS[s.kind].values.map((v) => <option key={v} value={v}>effort: {v}</option>)}
                    </select>
                  )}
                </span>
                <span className="kp">{s.kind && <KeyPill kind={s.kind} llm={llm} />}</span>
                <span>
                  {s.kind && (
                    <button className="btn ghost" onClick={() => remove(i)} disabled={chain.length <= 1} aria-label={t("modelSettings.removeStep", { x: i + 1 })}>{t("common.delete")}</button>
                  )}
                </span>
              </ChainRow>
            ))}
          </SortableContext>
        </DndContext>
      </section>
      <div className="btn-row">
        <button className="btn pri" onClick={() => run(() => api.setLlmChain(chain), t("modelSettings.saved"))}>{t("common.save")}</button>
        <span className="muted">{t("modelSettings.chainNote")}</span>
      </div>

      <section aria-labelledby="api-keys">
        <h2 id="api-keys">{t("modelSettings.apiKeys")}</h2>
        <p className="sec-d">{t.rich("modelSettings.apiKeysDesc", { code: <code>OPENAI_API_KEY</code>, code2: <code>GEMINI_API_KEY</code>, code3: <code>ANTHROPIC_API_KEY</code> })}</p>
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
                  placeholder={source === "stored" ? t("modelSettings.replaceKey") : t("modelSettings.apiKey", { label })}
                  aria-label={t("modelSettings.apiKey", { label })}
                  autoComplete="off"
                />
                <button
                  className="btn"
                  disabled={!keys[kind].trim()}
                  onClick={() => run(async () => { await api.setApiKey(kind, keys[kind]); setKeys((k) => ({ ...k, [kind]: "" })); }, t("modelSettings.keySaved", { label }))}
                >
                  {t("common.save")}
                </button>
                <button className="btn ghost" disabled={source !== "stored"} onClick={() => run(() => api.setApiKey(kind, null), t("modelSettings.keyDeleted", { label }))} aria-label={t("modelSettings.deleteKey", { label })}>{t("common.delete")}</button>
              </SetRow>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="untrusted">
        <h2 id="untrusted">{t("modelSettings.untrusted")}</h2>
        <div className="grp">
          <SetRow title={t("modelSettings.untrustedTitle")} desc={t("modelSettings.untrustedDesc")}>
            <span className="muted">{t("modelSettings.alwaysOn")}</span>
          </SetRow>
        </div>
      </section>
      {status && <p role="status" className="msg">{status}</p>}
      {error && <p role="alert" className="msg error-text">{t.msg(error)}</p>}
    </>
  );
}
