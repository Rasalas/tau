import { useEffect, useRef } from "react";
import { useThreadStore } from "../workbench-context";
import { threadFromUrl, threadUrlStep, urlWithThread } from "./thread-url";
import { viewportFit } from "./visual-viewport";
import "./touch.css";

/**
 * What the compact layout needs of the page beyond its components: the room
 * the on-screen keyboard leaves, a tap that reveals a message's actions where
 * a mouse would hover, and (in a browser) the open thread in the address.
 * Mounted only while the layout is compact.
 */
export function TouchLayer({ syncUrl, openThread }: { syncUrl: boolean; openThread(path: string): Promise<boolean> }) {
  useThreadUrl(syncUrl, openThread);
  useEffect(() => {
    const root = document.documentElement;
    const visual = window.visualViewport ?? undefined;
    const update = () => {
      const fit = viewportFit(window.innerHeight, visual);
      root.style.setProperty("--tau-viewport-height", `${fit.height}px`);
      root.style.setProperty("--tau-viewport-top", `${fit.top}px`);
      root.style.setProperty("--tau-keyboard-inset", `${Math.max(0, window.innerHeight - fit.height - fit.top)}px`);
      document.body.toggleAttribute("data-keyboard", fit.keyboard);
    };
    update();
    visual?.addEventListener("resize", update);
    visual?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      visual?.removeEventListener("resize", update);
      visual?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      root.style.removeProperty("--tau-viewport-height");
      root.style.removeProperty("--tau-viewport-top");
      root.style.removeProperty("--tau-keyboard-inset");
      document.body.removeAttribute("data-keyboard");
    };
  }, []);

  // A tap on a message shows its actions (copy, fork, edit) until another one is tapped.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest("button, a, input, textarea, [role=button]")) return;
      const shell = target.closest<HTMLElement>(".message-shell");
      for (const shown of document.querySelectorAll<HTMLElement>(".message-shell[data-touch-actions]")) {
        if (shown !== shell) shown.removeAttribute("data-touch-actions");
      }
      shell?.toggleAttribute("data-touch-actions");
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}

/** `?thread=<id>` opens that thread once the index has it, then follows whichever thread is open. */
function useThreadUrl(enabled: boolean, openThread: (path: string) => Promise<boolean>): void {
  const store = useThreadStore();
  const open = useRef(openThread);
  open.current = openThread;
  useEffect(() => {
    if (!enabled) return undefined;
    let wanted = threadFromUrl(window.location.href);
    let opening = false;
    let firstWrite = true;
    const apply = () => {
      const { threads, activeThreadId } = store.getSnapshot();
      const step = threadUrlStep({ wanted, inUrl: threadFromUrl(window.location.href), activeThreadId, threads, firstWrite });
      if (step.kind === "wait") return;
      if (step.kind === "open") {
        if (opening) return;
        opening = true;
        // One attempt: a thread that will not open leaves the address to the open one.
        const settle = () => { opening = false; wanted = undefined; apply(); };
        void open.current(step.path).then(settle, settle);
        return;
      }
      wanted = undefined;
      if (step.kind !== "write") return;
      const next = urlWithThread(window.location.href, step.threadId);
      if (step.push) window.history.pushState(window.history.state, "", next);
      else window.history.replaceState(window.history.state, "", next);
      firstWrite = false;
    };
    // Back and forward move between threads the address has held.
    const onPop = () => { wanted = threadFromUrl(window.location.href); apply(); };
    apply();
    const stop = store.subscribe(apply);
    window.addEventListener("popstate", onPop);
    return () => { stop(); window.removeEventListener("popstate", onPop); };
  }, [enabled, store]);
}
