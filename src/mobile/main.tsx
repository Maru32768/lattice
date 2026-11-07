import React from "react";
import ReactDOM from "react-dom/client";
import "../theme.css";
import "./mobile.css";
import { App } from "./App";
import { adoptToken } from "./client";

adoptToken();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
