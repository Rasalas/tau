import { useEffect, useId, useRef } from "react";
import { dismissPhoneReader, registerPhoneReader } from "../../workbench/phone-history";

/** The sheet's lifetime belongs to the phone route coordinator, including after reload. */
export function useWorkspaceFileHistory(id: string, onClose: () => void): () => void {
  const key = `${id}:${useId()}`;
  const close = useRef(onClose);
  close.current = onClose;
  const generation = useRef(0);
  useEffect(() => {
    const own = ++generation.current;
    const unregister = registerPhoneReader(key, () => close.current());
    return () => {
      // StrictMode remounts and replacements reclaim the reader before this runs.
      queueMicrotask(() => { if (generation.current === own) unregister(); });
    };
  }, [key]);
  return () => dismissPhoneReader(key);
}
