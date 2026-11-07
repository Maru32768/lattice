import { Component, type ReactNode } from "react";
import { useT } from "../i18n";

/** A page and documents of different versions can meet: a document it cannot draw must not leave a blank screen with no way out. */
export function Crashed() {
  const t = useT();
  return (
    <main className="m-empty">
      <p role="alert">{t("mobile.reloadPlease")}</p>
      <button className="btn" onClick={() => location.reload()}>
        {t("mobile.reload")}
      </button>
    </main>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  override state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  override render() {
    return this.state.crashed ? <Crashed /> : this.props.children;
  }
}
