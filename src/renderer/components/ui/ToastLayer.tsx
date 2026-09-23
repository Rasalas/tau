import { lazy, Suspense, useRef, useSyncExternalStore } from "react";
import type { ToastStore } from "../../../workbench/toast-store";

const LazyToastViewport = lazy(() => import("./Toasts").then(({ ToastViewport }) => ({ default: ToastViewport })));

/** Mounts the toast stack, and fetches its code and stylesheet, once there is a first toast to show. */
export function ToastLayer({ store }: { store: ToastStore }) {
  const count = useSyncExternalStore(store.subscribe, () => store.getToasts().length);
  const needed = useRef(false);
  if (count > 0) needed.current = true;
  if (!needed.current) return null;
  return <Suspense fallback={null}><LazyToastViewport store={store} /></Suspense>;
}
