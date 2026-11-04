/** The PDF viewer's table of contents and link targets, apart from pdf.js. Everything here comes from the untrusted PDF. */

/** Where to go: a place on a page (points from its top), or a PDF destination pdf.js resolves. */
export type Target = { page: number; y: number } | { dest: unknown };

export interface Entry {
  title: string;
  target: Target | null;
  items: Entry[];
}

/** The PDF's own bookmarks (`getOutline`). An entry with no place in the document stays for its children. */
export function bookmarkTree(items: readonly { title: string; dest: unknown; items: readonly unknown[] }[]): Entry[] {
  return items.map((i) => ({
    title: i.title.replace(/\s+/gu, " ").trim(),
    target: i.dest ? { dest: i.dest } : null,
    items: bookmarkTree(i.items as typeof items),
  }));
}

/** Contents for a PDF with no bookmarks, from the headings the extractor found. */
export function headingTree(regions: readonly { text: string; page: number; y0: number; level: number | null }[]): Entry[] {
  const roots: Entry[] = [];
  const open: { level: number; entry: Entry }[] = [];
  for (const r of regions) {
    if (r.level == null) {
      continue;
    }
    const entry: Entry = { title: r.text, target: { page: r.page, y: r.y0 }, items: [] };
    while ((open.at(-1)?.level ?? -1) >= r.level) {
      open.pop();
    }
    (open.at(-1)?.entry.items ?? roots).push(entry);
    open.push({ level: r.level, entry });
  }
  return roots;
}

/** The height a destination array names, in PDF coordinates (from the page's bottom); null when it names none. */
export function topOf(dest: readonly unknown[]): number | null {
  const name = (dest[1] as { name?: unknown } | null | undefined)?.name;
  const value = name === "XYZ" ? dest[3] : name === "FitH" || name === "FitBH" ? dest[2] : name === "FitR" ? dest[5] : null;
  return typeof value === "number" ? value : null;
}

/** A link a PDF may open: only the web, as in the page webview's own navigation rule. */
export function webLink(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
