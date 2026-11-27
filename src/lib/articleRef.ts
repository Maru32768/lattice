/** What the user copies for an agent or `lattice-cli`, which `get` reads back (`crates/lattice-core/src/article_ref.rs`). */
export function articleRef(id: number, blocks?: [number, number]): string {
  if (!blocks) {
    return `lattice:article/${id}`;
  }
  const [from, to] = blocks;
  return `lattice:article/${id}#b${from}${from === to ? "" : `-b${to}`}`;
}
