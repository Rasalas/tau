import { errorMessage, type WorkbenchActions } from "tau";

/** A WebView without the Web Share API (Android's) copies the link instead and says so. */
export async function sharePullRequestLink(request: { url: string; title: string }, actions: Pick<WorkbenchActions, "copyText" | "notify">): Promise<void> {
  const data = { url: request.url, title: request.title };
  if (typeof navigator !== "undefined" && typeof navigator.share === "function" && (typeof navigator.canShare !== "function" || navigator.canShare(data))) {
    try {
      await navigator.share(data);
      return;
    } catch (error) {
      // Closing the share sheet is an answer, not a failure.
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  try {
    await actions.copyText(request.url);
    actions.notify("Sharing is not available here. Copied the link instead.");
  } catch (error) {
    actions.notify(errorMessage(error), "error");
  }
}

export async function copyPullRequestLink(url: string, actions: Pick<WorkbenchActions, "copyText" | "notify">): Promise<void> {
  try {
    await actions.copyText(url);
    actions.notify("Copied the link.");
  } catch (error) {
    actions.notify(errorMessage(error), "error");
  }
}
