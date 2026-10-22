import { useLayoutEffect, useRef } from "react";

/** The last rendered `value`, for code that runs after an await, when the render it started in may be stale. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
