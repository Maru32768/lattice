// A white window leaves the process running, so only reading the page proves a packaged app started. Start the app with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>. Each read disconnects at once: with a debugger
// client attached, the app hangs when a webview opens.

import { setTimeout as sleep } from "node:timers/promises";

const TIMEOUT_MS = 120_000;
const EXPRESSION = 'JSON.stringify({ label: window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label, text: document.body?.innerText ?? "" })';

interface Page {
  label?: string;
  text: string;
}

function readPage(url: string): Promise<Page> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: EXPRESSION, returnByValue: true } }));
    });
    socket.addEventListener("message", (event) => {
      socket.close();
      // A page that is still navigating answers with an error instead of a value.
      const reply = JSON.parse(String(event.data)) as { result?: { result?: { value?: string } } };
      const value = reply.result?.result?.value;
      resolve(value ? (JSON.parse(value) as Page) : { text: "" });
    });
    socket.addEventListener("error", () => {
      reject(new Error(`Could not reach ${url}`));
    });
  });
}

// The app also keeps a spare window for pop-outs, so only the main one's text counts.
async function mainWindowText(port: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/json`);
  const targets = (await response.json()) as { type: string; webSocketDebuggerUrl: string }[];
  for (const target of targets.filter((t) => t.type === "page")) {
    const page = await readPage(target.webSocketDebuggerUrl);
    if (page.label === "main" && page.text.trim()) {
      return page.text.trim();
    }
  }
  return "";
}

const port = process.argv[2];
if (!port) {
  console.error("Usage: node scripts/smoke-webview.ts <debug-port>");
  process.exit(1);
}
setTimeout(() => {
  console.error(`The main window showed no text within ${TIMEOUT_MS / 1000} seconds`);
  process.exit(1);
}, TIMEOUT_MS);
for (;;) {
  const text = await mainWindowText(port).catch(() => "");
  if (text) {
    console.log(`Main window rendered: ${text.replaceAll(/\s+/g, " ").slice(0, 120)}`);
    process.exit(0);
  }
  await sleep(2000);
}
