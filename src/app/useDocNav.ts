import { useState } from "react";
import { createDocNav, type DocHost } from "../docnav/controller";
import { useLatest } from "../lib/useLatest";

/** The document keys for what the app itself shows: the Reader and the chat log. */
export function useDocNav(host: DocHost) {
  const latest = useLatest(host);
  const [nav] = useState(() => createDocNav(() => latest.current));
  return nav;
}
