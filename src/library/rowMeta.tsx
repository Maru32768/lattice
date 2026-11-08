// What a list row shows besides its title, on the PC and on the phone: no app-only imports here.
import type { ArticleRow } from "../bindings";
import { useT, type T } from "../i18n";

export const mmdd = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(5, 10).replace("-", "/") : `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

/** A status badge only when something is abnormal. */
export function badge(a: ArticleRow, translating: string | null, t: T): [string, string] | null {
  if (a.fetch_status === "pending") {
    return ["run", t("listPane.fetching")];
  }
  if (a.fetch_status === "failed") {
    return ["err", t("listPane.fetchFailed")];
  }
  if (a.extraction_status === "failed") {
    return ["err", t("listPane.extractFailed")];
  }
  if (translating) {
    return ["run", translating];
  }
  if (a.thin) {
    return ["warn", t("listPane.thin")];
  }
  return null;
}

/** Only important articles (4-5) get a mark; the reason is its tooltip. */
export function Importance({ a }: { a: ArticleRow }) {
  const t = useT();
  if (a.relevance == null || a.relevance < 4) {
    return null;
  }
  return (
    <span className={`imp s${a.relevance}`} title={a.relevance_reason ?? undefined}>
      {t("listPane.importance", { score: a.relevance })}
    </span>
  );
}
