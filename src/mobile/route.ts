/** `#/a/12` is article 12; anything else is the list. */
export function articleInHash(hash: string): number | null {
  const m = /^#\/a\/(\d+)$/.exec(hash);
  return m ? Number(m[1]) : null;
}
