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
mockWindows("main");
mockIPC((cmd, args) => {
  e2e.calls.push({ cmd, args });
  try {
    return handle(cmd, args);
  } catch (e) {
    if (String(e).includes("unmocked")) e2e.unmocked.push(cmd);
    throw e;
  }
}, { shouldMockEvents: true });

await import("../src/main.tsx");
