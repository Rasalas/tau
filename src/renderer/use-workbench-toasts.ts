import { useEffect, useRef } from "react";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import type { ToastHandle, ToastStore } from "../workbench/toast-store";
import type { HostClient } from "../workbench/host-client";
import { CONNECTION_DROPPED_MESSAGE, isConnectionDroppedNotice } from "../shared/connection-dropped-error";
import { useHostClient } from "./host-client-context";
import type { AppUpdate } from "./app-update";
import { noticeHeadline, plainNoticeText } from "./components/notice-text";
import { isMachineUpdateNotice } from "../shared/machine-compatibility";
import { openUpdates } from "./release-notes";

/** Every notice as a toast: the headline to read, the whole text to copy when it failed or was cut short. An error stays until dismissed. */
export function showNoticesAsToasts(view: ThreadViewStore, toasts: ToastStore, openMachines?: () => void,
  client?: Pick<HostClient, "getConnectionLink" | "onConnectionLink">): () => void {
  let dropped: ToastHandle | undefined;
  const dismissDropped = () => { dropped?.dismiss(); dropped = undefined; };
  const stopLink = client?.onConnectionLink((link) => { if (link.phase === "open") dismissDropped(); });
  const stopNotices = view.subscribeToNotice(() => {
    const notice = view.getNotice();
    if (!notice) return;
    const message = plainNoticeText(notice.message);
    if (isConnectionDroppedNotice(message)) {
      // A caller may report an old rejection after the replacement socket opened.
      if (client?.getConnectionLink()?.phase === "open") return;
      dropped = toasts.show({ id: "notice:connection-dropped", type: "info", description: CONNECTION_DROPPED_MESSAGE, timeoutMs: 5_000 });
      return;
    }
    const headline = noticeHeadline(message);
    toasts.show({
      // The same text again restarts its toast rather than stacking a copy.
      id: notice.id ?? `notice:${message}`,
      type: notice.level,
      description: headline,
      ...(openMachines && isMachineUpdateNotice(message) ? { actions: [{ label: "Machines", opens: true, run: openMachines }] } : {}),
      ...(notice.level !== "info" || headline !== message.trim() ? { copyText: message } : {}),
    });
  });
  return () => { stopNotices(); stopLink?.(); dismissDropped(); };
}

/**
 * Core's own toasts: the notices, and the restart a downloaded update waits for;
 * closed, the sidebar's foot still offers it. After Restart it follows the
 * install until Tau quits (K161).
 */
export function useWorkbenchToasts({ view, toasts, update, openMachines, reviewUpdate }: {
  view: ThreadViewStore;
  toasts: ToastStore;
  update?: AppUpdate | undefined;
  openMachines?: () => void;
  reviewUpdate?(): void;
}): void {
  const client = useHostClient();
  const machines = useRef(openMachines);
  machines.current = openMachines;
  const hasMachines = !!openMachines;
  useEffect(() => showNoticesAsToasts(view, toasts, hasMachines ? () => machines.current?.() : undefined, client), [toasts, view, hasMachines, client]);
  const install = useRef(update?.install);
  install.current = update?.install;
  const review = useRef(reviewUpdate);
  review.current = reviewUpdate;
  const { version, phase, progress } = update ?? {};
  useEffect(() => {
    if (!version) return;
    toasts.show({
      id: "tau.update",
      ...(phase ? { type: "loading" } : {}),
      title: phase === "installing" ? `Installing Tau ${version}` : phase === "downloading" ? `Downloading Tau ${version}…` : phase ? `Preparing Tau ${version}…` : `Tau ${version} downloaded`,
      description: phase === "installing" ? "Tau reopens by itself when it is done. This can take a few minutes."
        : phase ? `${progress === undefined ? "" : `${progress}% · `}Tau restarts once it is ready.` : "Review what changed before installing.",
      timeoutMs: 0,
      actions: phase ? [] : [{ label: "Review update", opens: true, keepOpen: true, run: () => { if (!openUpdates()) { if (review.current) review.current(); else install.current?.(); } } }],
    });
  }, [toasts, version, phase, progress]);
}
