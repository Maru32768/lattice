// Runs in the page before the app: the real frontend over the mock backend.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { handle } from "./mock.ts";

declare global {
  interface Window {
    __e2e: { calls: { cmd: string; args: unknown }[]; unmocked: string[]; emit: typeof emit };
  }
}

const e2e: Window["__e2e"] = { calls: [], unmocked: [], emit };
window.__e2e = e2e;
// `?window=<label>` starts the page as that window (a pop-out, G52); the app reads its label.
mockWindows(new URLSearchParams(location.search).get("window") ?? "main");
mockIPC(
  (cmd, args) => {
    e2e.calls.push({ cmd, args });
    try {
      return handle(cmd, args);
    } catch (e) {
      if (String(e).includes("unmocked")) {
        e2e.unmocked.push(cmd);
      }
      throw e;
    }
  },
  { shouldMockEvents: true },
);
// The event mock swallows events to other windows (G52 requests); record them for the specs.
type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
const invoke = internals.invoke;
internals.invoke = (cmd, args, options) => {
  if (cmd === "plugin:event|emit_to") {
    e2e.calls.push({ cmd, args });
  }
  return invoke(cmd, args, options);
};

await import("../src/main.tsx");
