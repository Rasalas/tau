import { useEffect, useRef } from "react";
import type { ThreadViewStore } from "../workbench/thread-view-store";
import type { ToastStore } from "../workbench/toast-store";
import type { AppUpdate } from "./app-update";
import { noticeHeadline } from "./components/notice-text";
import { isMachineUpdateNotice } from "../shared/machine-compatibility";

/** Every notice as a toast: the headline to read, the whole text to copy when it failed or was cut short. */
export function showNoticesAsToasts(view: ThreadViewStore, toasts: ToastStore, openMachines?: () => void): () => void {
  return view.subscribeToNotice(() => {
    const notice = view.getNotice();
    if (!notice) return;
    const headline = noticeHeadline(notice.message);
    toasts.show({
      // The same text again restarts its toast rather than stacking a copy.
      id: `notice:${notice.message}`,
      type: notice.level,
      description: headline,
      ...(openMachines && isMachineUpdateNotice(notice.message) ? { actions: [{ label: "Machines", run: openMachines }] } : {}),
      ...(notice.level !== "info" || headline !== notice.message.trim() ? { copyText: notice.message } : {}),
    });
  });
}

/**
 * Core's own toasts: the notices, and the restart a downloaded update waits for;
 * closed, the sidebar's foot still offers it. After Restart it follows the
 * install until Tau quits (K161).
 */
export function useWorkbenchToasts({ view, toasts, update, openMachines }: {
  view: ThreadViewStore;
  toasts: ToastStore;
  update?: AppUpdate | undefined;
  openMachines?: () => void;
}): void {
  const machines = useRef(openMachines);
  machines.current = openMachines;
  const hasMachines = !!openMachines;
  useEffect(() => showNoticesAsToasts(view, toasts, hasMachines ? () => machines.current?.() : undefined), [toasts, view, hasMachines]);
  const install = useRef(update?.install);
  install.current = update?.install;
  const { version, phase, progress } = update ?? {};
  useEffect(() => {
    if (!version) return;
    toasts.show({
      id: "tau.update",
      ...(phase ? { type: "loading" } : {}),
      title: phase === "installing" ? `Installing Tau ${version}` : phase === "downloading" ? `Downloading Tau ${version}…` : phase ? `Preparing Tau ${version}…` : `Tau ${version} downloaded`,
      description: phase === "installing" ? "Tau reopens by itself when it is done. This can take a few minutes."
        : phase ? `${progress === undefined ? "" : `${progress}% · `}Tau restarts once it is ready.` : "Restart to install it.",
      timeoutMs: 0,
      actions: phase ? [] : [{ label: "Restart", keepOpen: true, run: () => install.current?.() }],
    });
  }, [toasts, version, phase, progress]);
}
