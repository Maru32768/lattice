import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import { Icon } from "./Icon";

/** One request per key for the whole app: a list of 1,000 rows asks once per site. A key is a
 *  domain (the site's icon) or `feed:<id>` (the icon the user picked for that feed). */
const icons = new Map<string, Promise<string | null>>();
/** Mounted icons per key, re-asked when the icon behind it changes. */
const waiting = new Map<string, Set<() => void>>();

function forget(key: string) {
  icons.delete(key);
  waiting.get(key)?.forEach((f) => f());
}

listen<string>("favicon-changed", (e) => forget(e.payload)).catch(() => {});

/** After the user picked or removed a feed's icon. */
export const feedIconChanged = (id: number) => forget(`feed:${id}`);

function icon(key: string) {
  let p = icons.get(key);
  if (!p) {
    // A failed ask is not kept: the next mount asks again rather than showing no icon all session.
    p = (key.startsWith("feed:") ? api.feedIcon(Number(key.slice(5))) : api.favicon(key)).catch(() => {
      icons.delete(key);
      return null;
    });
    icons.set(key, p);
  }
  return p;
}

/** The icon's data URL; null when there is none, undefined while asking (or for an empty key). */
function useIcon(key: string): string | null | undefined {
  const [got, setGot] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!key) {
      return;
    }
    let live = true;
    const load = () =>
      void icon(key).then((url) => {
        if (live) {
          setGot({ key, url });
        }
      });
    load();
    const set = waiting.get(key) ?? new Set();
    waiting.set(key, set);
    set.add(load);
    return () => {
      live = false;
      set.delete(load);
    };
  }, [key]);
  return got?.key === key ? got.url : undefined;
}

export const hostOf = (url: string) => URL.parse(url)?.hostname ?? "";

/** The site's icon (16 px), fetched and stored by the backend; for a feed's articles, the icon the
 *  user picked for the feed instead. Its initial until there is one. */
export function Favicon({ domain, feed }: { domain: string; feed?: number | null }) {
  const custom = useIcon(feed != null ? `feed:${feed}` : "");
  const site = useIcon(feed == null || custom === null ? domain : "");
  const url = custom ?? site;
  // A picked icon may be SVG: shown only through <img> from a data: URL, where it runs no script.
  if (url) {
    return <img className="favicon" src={url} alt="" width={16} height={16} />;
  }
  // No domain: imported Markdown, a local document.
  if (!domain) {
    return (
      <span className="favicon letter" aria-hidden="true">
        <Icon name="reader" size="sm" />
      </span>
    );
  }
  return (
    <span className="favicon letter" aria-hidden="true">
      {domain
        .replace(/^www\./, "")
        .charAt(0)
        .toUpperCase()}
    </span>
  );
}
