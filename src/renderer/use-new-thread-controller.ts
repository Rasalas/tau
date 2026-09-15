import { useCallback, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";
import { NewThreadController, type NewThreadPromotionContext } from "../workbench/new-thread-controller";
import type { ClientStorage } from "../workbench/client-storage";
import type { NewThreadDraft } from "../workbench/draft-store";

export type { NewThreadPromotionContext };

/**
 * Thin adapter over the platform-neutral NewThreadController. Reads go
 * through useSyncExternalStore so a change written in a layout effect is
 * still reflected by the rendered snapshot.
 */
export function useNewThreadController(storage: ClientStorage) {
  const [controller] = useState(() => new NewThreadController(storage));
  const pendingNewThread = useSyncExternalStore(controller.subscribe, controller.current);

  // Stable across renders (created once); its getter reads the live id in
  // the controller, so begin/invalidate changes are visible immediately.
  const requestRef = useRef({ get current() { return controller.requestId(); } });
  const requestId = requestRef.current;

  const setPendingNewThread = useCallback((value: SetStateAction<NewThreadDraft | undefined>) => {
    controller.set(value);
  }, [controller]);

  return {
    pendingNewThread,
    setPendingNewThread,
    current: controller.current,
    requestId,
    begin: controller.begin,
    invalidate: controller.invalidate,
    isCurrent: controller.isCurrent,
    markAwaitingPromotion: controller.markAwaitingPromotion,
    promoteFromHostReport: controller.promoteFromHostReport,
    promoteFromUserMessage: controller.promoteFromUserMessage,
    setModel: controller.setModel,
  };
}
