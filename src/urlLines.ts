/** Non-blank lines of pasted text that hold no http(s) URL, by why: another scheme (ftp://) or no URL at all. */
export function skippedLines(text: string): { scheme: number; noUrl: number } {
  let scheme = 0, noUrl = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim() || /https?:\/\//u.test(line)) continue;
    if (/[a-z][a-z\d+.-]*:\/\//iu.test(line)) scheme++;
    else noUrl++;
  }
  return { scheme, noUrl };
}
