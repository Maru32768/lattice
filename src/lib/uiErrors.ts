/** Which uncaught UI errors go to the app log: each distinct message once, at most `limit` a window,
 * so an error thrown every frame, even one with a counter in its text, cannot flood the kept files. */
export function errorFilter(limit = 50): (message: string) => boolean {
  const seen = new Set<string>();
  return (message) => {
    if (seen.has(message) || seen.size >= limit) {
      return false;
    }
    seen.add(message);
    return true;
  };
}
