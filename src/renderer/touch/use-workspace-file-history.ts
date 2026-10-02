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
    let mounted = true;
    const unregister = registerPhoneReader(key, () => { if (mounted) close.current(); });
    return () => {
      mounted = false;
      // StrictMode remounts and replacements reclaim the reader before this runs.
      queueMicrotask(() => { if (generation.current === own) unregister(); });
    };
  }, [key]);
  return () => dismissPhoneReader(key);
}
