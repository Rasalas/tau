import { useEffect, useRef } from "react";
import { useThreadStore } from "../workbench-context";
import { useAppPageStore } from "../app-page-context";
import {
  PHONE_HOME, historySteps, routeFromState, routeFromUrl, routeKey, routePath, sameRoute, stateWithRoute, urlWithRoute,
  type HistorySteps, type PhoneRoute,
} from "../../workbench/phone-route";
import { pageFromUrl, urlWithPage } from "./page-url";
import { threadFromUrl, threadUrlStep, urlWithThread } from "./thread-url";
import { viewportFit } from "./visual-viewport";
import "./touch.css";

/** A phone's route and how to go there; see `usePhoneNavigation`. */
export interface PhoneRouting {
  route: PhoneRoute;
  onRoute(route: PhoneRoute): void;
}

/**
 * What the compact layout needs of the page beyond its components: the room
 * the on-screen keyboard leaves, a tap that reveals a message's actions where
 * a mouse would hover, and (in a browser) where it is in the address and the
 * history. Mounted only while the layout is compact; `phone` is set on one
 * screen, where the list is home and back steps out of a chat.
 */
export function TouchLayer({ syncUrl, openThread, phone }: { syncUrl: boolean; openThread(path: string): Promise<boolean>; phone?: PhoneRouting }) {
  useThreadUrl(syncUrl && !phone, openThread);
  usePageUrl(syncUrl && !phone);
  usePhoneHistory(syncUrl ? phone : undefined, openThread);
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

/** `?page=<id>` opens that page; opening one adds an entry, so back leaves it. */
function usePageUrl(enabled: boolean): void {
  const pages = useAppPageStore();
  useEffect(() => {
    if (!enabled || !pages) return undefined;
    let pushed = false;
    const wanted = pageFromUrl(window.location.href);
    if (wanted) pages.open(wanted);
    const apply = () => {
      const open = pages.getSnapshot()?.id;
      const inUrl = pageFromUrl(window.location.href);
      if (open === inUrl) return;
      if (open) {
        const next = urlWithPage(window.location.href, open);
        if (inUrl) window.history.replaceState(window.history.state, "", next);
        else { window.history.pushState(window.history.state, "", next); pushed = true; }
        return;
      }
      // Closed in the page: the entry it added goes, so back does not open it again.
      if (pushed) { pushed = false; window.history.back(); }
      else window.history.replaceState(window.history.state, "", urlWithPage(window.location.href, undefined));
    };
    const onPop = () => {
      pushed = false;
      const inUrl = pageFromUrl(window.location.href);
      if (!inUrl) pages.close();
      else if (pages.getSnapshot()?.id !== inUrl) pages.open(inUrl);
    };
    const stop = pages.subscribe(apply);
    window.addEventListener("popstate", onPop);
    return () => { stop(); window.removeEventListener("popstate", onPop); };
  }, [enabled, pages]);
}

/**
 * The history as the path from home to the phone's route: a sub-page adds an
 * entry, leaving it goes back one, so the system's back (Android back, an iOS
 * swipe) steps out of a chat, a page's view or a Settings section, and stops
 * at the list. The address names the route for a reload, a link or a push.
 */
function usePhoneHistory(phone: PhoneRouting | undefined, openThread: (path: string) => Promise<boolean>): void {
  const store = useThreadStore();
  const latest = useRef({ phone, openThread });
  latest.current = { phone, openThread };
  const enabled = Boolean(phone);
  // The route the history's top entry holds, and steps waiting for a back to land.
  const shown = useRef<PhoneRoute | undefined>(undefined);
  const pending = useRef<HistorySteps | undefined>(undefined);
  const sync = useRef<() => void>(() => undefined);
  // The route the last sync saw; a change from it is the user's move.
  const seen = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled) return undefined;
    const write = (steps: HistorySteps) => {
      const href = window.location.href;
      if (steps.replace) window.history.replaceState(stateWithRoute(window.history.state, steps.replace), "", urlWithRoute(href, steps.replace));
      for (const route of steps.push) window.history.pushState(stateWithRoute(null, route), "", urlWithRoute(href, route));
    };
    sync.current = () => {
      const to = latest.current.phone?.route;
      const from = shown.current;
      if (!to || !from || pending.current || sameRoute(from, to)) return;
      const steps = historySteps(from, to);
      shown.current = to;
      if (steps.back === 0) { write(steps); return; }
      pending.current = steps;
      window.history.go(-steps.back);
    };

    // A thread the history names opens once the index has it; one the host does not know leaves for the list.
    let waiting: PhoneRoute | undefined;
    const apply = (route: PhoneRoute) => {
      waiting = undefined;
      const go = latest.current.phone?.onRoute;
      if (route.kind !== "chat" || !route.thread) { go?.(route); return; }
      const { threads, activeThreadId } = store.getSnapshot();
      const target = threads.find((thread) => thread.id === route.thread);
      if (!target) {
        if (threads.length === 0) waiting = route;
        else go?.(PHONE_HOME);
        return;
      }
      if (target.id === activeThreadId) go?.(route);
      else void latest.current.openThread(target.path);
    };

    // An entry this client wrote keeps its route; a fresh load builds the path to the address's.
    const stamped = routeFromState(window.history.state);
    const start = stamped ?? routeFromUrl(window.location.href);
    if (!stamped) {
      const href = window.location.href;
      const [home, ...rest] = routePath(start);
      window.history.replaceState(stateWithRoute(window.history.state, home!), "", urlWithRoute(href, home!));
      for (const route of rest) window.history.pushState(stateWithRoute(null, route), "", urlWithRoute(href, route));
    }
    shown.current = start;
    seen.current = routeKey(latest.current.phone!.route);
    if (routeKey(start) !== seen.current) apply(start);

    const onPop = (event: PopStateEvent) => {
      const steps = pending.current;
      if (steps) {
        pending.current = undefined;
        write(steps);
        sync.current();
        return;
      }
      // The user's back or forward, or a link that pushed an address.
      const stampedRoute = routeFromState(event.state);
      const route = stampedRoute ?? routeFromUrl(window.location.href);
      if (!stampedRoute) window.history.replaceState(stateWithRoute(event.state, route), "", urlWithRoute(window.location.href, route));
      shown.current = route;
      apply(route);
    };
    const stop = store.subscribe(() => { if (waiting) apply(waiting); });
    window.addEventListener("popstate", onPop);
    return () => {
      stop();
      window.removeEventListener("popstate", onPop);
      shown.current = undefined;
      pending.current = undefined;
    };
  }, [enabled, store]);

  const key = phone ? routeKey(phone.route) : undefined;
  useEffect(() => {
    if (key === undefined || key === seen.current) return;
    seen.current = key;
    sync.current();
  }, [key]);
}
