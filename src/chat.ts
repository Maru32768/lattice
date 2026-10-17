/** Splits an answer into text and `[n]` markers; only numbers in `cited` become markers. */
export function splitCitations(answer: string, cited: Set<number>): ({ n: number } | string)[] {
  return answer.split(/(\[\d+\])/)
    .map((p) => {
      const n = Number(/^\[(\d+)\]$/.exec(p)?.[1]);
      return cited.has(n) ? { n } : p;
    })
    .filter((p) => p !== "");
}
