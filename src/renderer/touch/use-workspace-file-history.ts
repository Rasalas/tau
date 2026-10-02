import { useEffect, useId, useRef } from "react";

const READER = "tau.workspace-file-reader";
function entry(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return state && typeof state === "object" ? state as Record<string, unknown> : {};
}

/** One modal step above the existing chat route, including after a reload. */
export function useWorkspaceFileHistory(id: string, onClose: () => void): () => void {
  const key = `${id}:${useId()}`;
  const close = useRef(onClose);
  close.current = onClose;
  const generation = useRef(0);
  useEffect(() => {
    const own = ++generation.current;
    const state = entry();
    if (state[READER] !== key) {
      // Switching or restoring the reader replaces its modal step, never stacks a sheet.
      if (typeof state[READER] === "string") window.history.replaceState({ ...state, [READER]: key }, "");
      else window.history.pushState({ ...state, [READER]: key }, "");
    }
    const onPop = () => { if (entry()[READER] !== key) close.current(); };
    window.addEventListener("popstate", onPop, true);
    return () => {
      window.removeEventListener("popstate", onPop, true);
      // Release the step on layout/navigation teardown. A StrictMode remount
      // or replacement reader takes ownership before this microtask, so keeps it.
      queueMicrotask(() => {
        if (generation.current === own && entry()[READER] === key) window.history.back();
      });
    };
  }, [key]);
  return () => {
    if (entry()[READER] === key) window.history.back();
    else close.current();
  };
}
