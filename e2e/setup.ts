// Runs in the page before the app: the real frontend over the mock backend.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { handle, mcpActivity, mcpApprovals } from "./mock.ts";
import { api } from "../src/api.ts";

declare global {
  interface Window {
    __e2e: {
      calls: { cmd: string; args: unknown }[];
      unmocked: string[];
      emit: typeof emit;
      fromPage: typeof emit;
      deleteArticle: typeof api.deleteArticle;
      mcpActivity: typeof mcpActivity;
      mcpApprovals: typeof mcpApprovals;
      /** Lets the oldest `n` waiting calls of `cmd` through (the newest `-n` when below 0), all of them by default; later calls wait again. */
      release: (cmd: string, n?: number) => void;
    };
    /** Set by an init script: commands whose calls wait for `__e2e.release`, as slow reads would. */
    __e2eHold?: string[];
    /** Set by an init script: commands answered at once but delivered at `__e2e.release`, as a read that loses a race would. */
    __e2eLate?: string[];
    /** Set by an init script: commands that fail, as a broken read would. */
    __e2eFail?: string[];
  }
}

/** An event from a page that holds the keyboard: a real one takes it from this document, which Playwright's always has. */
const fromPage: typeof emit = async (event, payload) => {
  document.hasFocus = () => false;
  await emit(event, payload);
  delete (document as Partial<Document>).hasFocus;
};
const late = window.__e2eLate ?? [];
const held = new Map([...(window.__e2eHold ?? []), ...late].map((cmd) => [cmd, [] as (() => void)[]]));
function release(cmd: string, n = Infinity) {
  const waiting = held.get(cmd) ?? [];
  for (const go of n < 0 ? waiting.splice(n) : waiting.splice(0, n)) {
    go();
  }
}
const e2e: Window["__e2e"] = { calls: [], unmocked: [], emit, fromPage, deleteArticle: api.deleteArticle, mcpActivity, mcpApprovals, release };
window.__e2e = e2e;
// `?window=<label>` starts the page as that window (a pop-out, G52); the app reads its label.
mockWindows(new URLSearchParams(location.search).get("window") ?? "main");
mockIPC(
  (cmd, args) => {
    e2e.calls.push({ cmd, args });
    const run = () => {
      try {
        if (window.__e2eFail?.includes(cmd)) {
          throw new Error(`${cmd} failed`);
        }
        return handle(cmd, args);
      } catch (e) {
        if (String(e).includes("unmocked")) {
          e2e.unmocked.push(cmd);
        }
        throw e;
      }
    };
    const waiting = held.get(cmd);
    if (!waiting) {
      return run();
    }
    const answer = late.includes(cmd) ? Promise.resolve().then(run) : null;
    return new Promise<void>((go) => waiting.push(go)).then(() => answer ?? run());
  },
  { shouldMockEvents: true },
);
// The event mock swallows events to other windows (G52 requests); record them for the specs.
// A PDF's name and 自動で翻訳しない travel in headers, which the IPC mock never sees: recorded as "import_pdf_bytes.headers".
type Invoke = (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>;
const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
const invoke = internals.invoke;
internals.invoke = (cmd, args, options) => {
  if (cmd === "plugin:event|emit_to") {
    e2e.calls.push({ cmd, args });
  }
  if (cmd === "import_pdf_bytes") {
    // Real IPC puts these in fetch headers, which take bytes only: a name sent without percent-encoding throws there.
    e2e.calls.push({ cmd: "import_pdf_bytes.headers", args: Object.fromEntries(new Headers(options?.headers)) });
  }
  return invoke(cmd, args, options);
};

await import("../src/main.tsx");
