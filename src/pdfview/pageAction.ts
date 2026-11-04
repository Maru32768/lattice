/** What a page's button offers, from the overlay's state of each region on the page. */
export function pageAction(states: (string | undefined)[]): "none" | "busy" | "redo" | "translate" {
  if (states.every((s) => s === "skip")) {
    return "none";
  }
  if (states.includes("translating")) {
    return "busy";
  }
  return states.every((s) => s === "done" || s === "skip") ? "redo" : "translate";
}
