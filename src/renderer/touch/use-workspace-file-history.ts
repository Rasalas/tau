import { useEffect, useId, useRef } from "react";
import { dismissPhoneReader, registerPhoneReader } from "../../workbench/phone-history";

let opened = 0;

/** Each compact dialog registers one back step with the phone route coordinator. */
export function useWorkspaceFileHistory(id: string, onClose: () => void, enabled = true): () => void {
  const instance = useId();
  const key = useRef(`${id}:${instance}`).current;
  const close = useRef(onClose);
  close.current = onClose;
  const generation = useRef(0);
  // Rendering orders a parent before its child; effects run in the opposite order.
  const order = useRef(0);
  if (enabled && order.current === 0) order.current = ++opened;
  useEffect(() => {
    if (!enabled) return;
    const own = ++generation.current;
    let mounted = true;
    const unregister = registerPhoneReader(key, () => { if (mounted) close.current(); }, order.current);
    return () => {
      mounted = false;
      // StrictMode remounts and replacements reclaim the reader before this runs.
      queueMicrotask(() => { if (generation.current === own) unregister(); });
    };
  }, [key, enabled]);
  return () => enabled ? dismissPhoneReader(key) : onClose();
}
