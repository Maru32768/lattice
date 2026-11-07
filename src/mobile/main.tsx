import React from "react";
import ReactDOM from "react-dom/client";
import "../theme.css";
import "./mobile.css";
import { App } from "./App";
import { adoptToken } from "./client";

// The list restores its own place (App.tsx): the browser would try before the rows are drawn.
history.scrollRestoration = "manual";
adoptToken();
// Needs a secure context: on the local network's plain HTTP the page simply needs the PC to be there.
if (isSecureContext && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("sw.js").catch(() => {});
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
