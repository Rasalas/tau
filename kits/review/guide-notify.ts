import { useEffect, useRef } from "react";
import type { HostExtensionClient, RegionProps, ToastOptions, WorkbenchActions } from "tau";
import { guideClient } from "./guide-client.js";
import type { GuideEvent } from "./guide-protocol.js";
import { openPullRequest } from "./pull-request-open.js";
import { parseRequestUrl } from "./pull-request-json.js";

type Actions = Pick<WorkbenchActions, "openStageTab" | "toast"> & Partial<Pick<WorkbenchActions, "openPage">>;

/** The toast a run's end shows, or nothing for the events that are not an end. */
export function guideToast(event: GuideEvent, open: () => void): ToastOptions | undefined {
  const what = `#${event.number}${event.title ? ` ${event.title}` : ""}`;
  if (event.kind === "ready") return { id: `review-guide:${event.url}`, type: "success", title: "Review guide ready", description: what, actions: [{ label: "Open", opens: true, run: open }] };
  if (event.kind === "failed") return { id: `review-guide:${event.url}`, type: "error", title: "Review guide failed", description: what, actions: [{ label: "Open", opens: true, run: open }] };
  return undefined;
}

/**
 * Tells the window when a guide run ends, wherever the reader is. The toast opens the request at
 * its guide; every window the host serves hears the event and shows its own.
 */
export function watchGuideRuns(host: Pick<HostExtensionClient, "invoke" | "onEvent">, actions: () => Actions): () => void {
  return guideClient(host).onChanged((event) => {
    const request = parseRequestUrl(event.url);
    const current = actions();
    const toast = guideToast(event, () => {
      if (request) openPullRequest(current, { url: request.url, number: request.number, provider: request.service }, undefined, "guide");
    });
    if (toast) current.toast?.(toast);
  });
}

/** An invisible region that keeps the watch for as long as the kit is active. */
export function createGuideRunWatcher(host: Pick<HostExtensionClient, "invoke" | "onEvent">) {
  return function GuideRunWatcher({ actions }: RegionProps) {
    const latest = useRef(actions);
    latest.current = actions;
    useEffect(() => watchGuideRuns(host, () => latest.current), []);
    return null;
  };
}
