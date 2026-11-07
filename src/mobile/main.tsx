import React from "react";
import ReactDOM from "react-dom/client";
import "../theme.css";
import "./mobile.css";
import { App } from "./App";
import { adoptToken } from "./client";

// The list restores its own place (App.tsx): the browser would try before the rows are drawn.
history.scrollRestoration = "manual";
adoptToken();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
