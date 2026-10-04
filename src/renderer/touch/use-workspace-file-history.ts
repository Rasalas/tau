import { useEffect, useId, useRef } from "react";
import { dismissPhoneReader, registerPhoneReader } from "../../workbench/phone-history";

/** Sheets and image previews share the phone route coordinator's back step. */
export function useWorkspaceFileHistory(id: string, onClose: () => void, enabled = true): () => void {
  const key = `${id}:${useId()}`;
  const close = useRef(onClose);
  close.current = onClose;
  const generation = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const own = ++generation.current;
    let mounted = true;
    const unregister = registerPhoneReader(key, () => { if (mounted) close.current(); });
    return () => {
      mounted = false;
      // StrictMode remounts and replacements reclaim the reader before this runs.
      queueMicrotask(() => { if (generation.current === own) unregister(); });
    };
  }, [key, enabled]);
  return () => enabled ? dismissPhoneReader(key) : onClose();
}
