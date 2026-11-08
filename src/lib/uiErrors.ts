/** Which uncaught UI errors go to the app log, and as what: each distinct message once an hour, at
 * most `limit` an hour, so an error thrown every frame, even one with a counter in its text, cannot
 * flood the kept files. A window lives for days in the tray, so the hour starts over; the record
 * that fills it says the rest of the hour is not logged, so the log does not just go quiet. */
export function errorFilter(limit = 50, hourMs = 3_600_000): (message: string, now: number) => string | null {
  let seen = new Set<string>();
  let since = -Infinity;
  return (message, now) => {
    if (now - since >= hourMs) {
      seen = new Set();
      since = now;
    }
    if (seen.has(message) || seen.size > limit) {
      return null;
    }
    seen.add(message);
    return seen.size > limit ? `${limit} UI errors this hour: the rest of the hour is not logged` : message;
  };
}
