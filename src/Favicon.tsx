import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";

/** One request per domain for the whole app: a list of 1,000 rows asks once per site. */
const icons = new Map<string, Promise<string | null>>();
/** Mounted icons per domain, re-asked when a background fetch for it finishes. */
const waiting = new Map<string, Set<() => void>>();

listen<string>("favicon-changed", (e) => {
  icons.delete(e.payload);
  waiting.get(e.payload)?.forEach((f) => f());
}).catch(() => {});

function icon(domain: string) {
  let p = icons.get(domain);
  if (!p) {
    p = api.favicon(domain).catch(() => null);
    icons.set(domain, p);
  }
  return p;
}

export const hostOf = (url: string) => URL.parse(url)?.hostname ?? "";

/** The site's icon (16 px), fetched and stored by the backend; its initial until there is one. */
export function Favicon({ domain }: { domain: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    if (!domain) return;
    const set = waiting.get(domain) ?? new Set();
    waiting.set(domain, set);
    const bump = () => setSeq((n) => n + 1);
    set.add(bump);
    return () => { set.delete(bump); };
  }, [domain]);
  useEffect(() => {
    if (!domain) return;
    let live = true;
    icon(domain).then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [domain, seq]);
  if (url) return <img className="favicon" src={url} alt="" width={16} height={16} />;
  return <span className="favicon letter" aria-hidden="true">{domain.replace(/^www\./, "").charAt(0).toUpperCase()}</span>;
}
