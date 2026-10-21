import React from "react";
import ReactDOM from "react-dom/client";
// Bundled so the app works offline under the CSP (default-src 'self').
import "@fontsource/ibm-plex-sans-jp/400.css";
import "@fontsource/ibm-plex-sans-jp/500.css";
import "@fontsource/ibm-plex-sans-jp/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource-variable/source-serif-4/opsz.css";
import "@fontsource/noto-serif-jp/400.css";
import "@fontsource/noto-serif-jp/600.css";
import "./theme.css";
import App from "./App";
import { ja } from "./i18n/ja";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// The JP font is split into ~120 subsets fetched on first use, so a menu opened for the first time
// drew its box a frame or more before its text (H8). Fetch the ones the UI's own text needs up front.
const uiText = [...new Set(Object.values(ja).join(""))].join("");
requestIdleCallback(() => {
  for (const w of [400, 500, 600]) document.fonts.load(`${w} 12px "IBM Plex Sans JP"`, uiText).catch(() => {});
});
