// A remote page in the in-app browser: the page overlay over a long article, its calls to the app recorded.
// The overlay asks for its IPC only when it calls, so it may start before the stand-in below.
import "../src/overlay/index.ts";

declare global {
  interface Window {
    __pageCalls: { cmd: string; args?: unknown }[];
  }
}

window.__pageCalls = [];
const main = document.getElementById("main")!;
for (let i = 0; i < 60; i++) {
  const p = document.createElement("p");
  p.textContent = `Page paragraph ${i}. ${"Some words of the page. ".repeat(6)}`;
  main.append(p);
}
Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: unknown) => {
      window.__pageCalls.push({ cmd, args });
      return Promise.resolve(null);
    },
  },
});
