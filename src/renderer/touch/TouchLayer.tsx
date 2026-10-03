import { useEffect, useRef } from "react";
import { useThreadStore } from "../workbench-context";
import { useAppPageStore } from "../app-page-context";
import { PHONE_HOME, type PhoneRoute } from "../../workbench/phone-route";
import {
  claimPhoneReaderRoute, closePhoneReader, coordinatePhoneReaderHistory, currentPhoneReader, phoneReaderFromState, stateWithPhoneReader, historySteps, routeFromState, routeFromUrl, routeKey, routePath, sameRoute, stateWithRoute, urlWithRoute, type HistorySteps,
} from "../../workbench/phone-history";
import { pageFromUrl, urlWithPage } from "./page-url";
import { threadFromUrl, threadUrlStep, urlWithThread } from "./thread-url";
import { editingFocused, tallestHeight, viewportFit } from "./visual-viewport";
import { useClientEnvironment } from "../client-environment";
import "./touch.css";

/** A phone's route and how to go there; see `usePhoneNavigation`. */
export interface PhoneRouting {
  route: PhoneRoute;
  onRoute(route: PhoneRoute): void;
}

/**
 * What the compact layout needs of the page beyond its components: the room
 * the on-screen keyboard leaves, and (in a browser) where it is in the address and the
 * history. Mounted only while the layout is compact; `phone` is set on one
 * screen, where the list is home and back steps out of a chat.
 */
export function TouchLayer({ syncUrl, openThread, phone }: { syncUrl: boolean; openThread(path: string): Promise<boolean>; phone?: PhoneRouting }) {
  const { mobileApp } = useClientEnvironment();
  const floatingToolbar = mobileApp?.platform === "ios" && !phone;
  useThreadUrl(syncUrl && !phone, openThread);
  usePageUrl(syncUrl && !phone);
  usePhoneHistory(syncUrl ? phone : undefined, openThread);
  useEffect(() => {
    const root = document.documentElement;
    const visual = window.visualViewport ?? undefined;
    let tallest: { width: number; height: number } | undefined;
    const update = () => {
      tallest = tallestHeight(tallest, window.innerWidth, window.innerHeight);
      const fit = viewportFit(window.innerHeight, visual, { tallest: tallest.height, editing: editingFocused(document.activeElement) }, floatingToolbar);
      const toolbar = floatingToolbar && !fit.keyboard;
      const inset = Math.max(0, window.innerHeight - (toolbar ? visual?.height ?? window.innerHeight : fit.height + fit.top));
      root.style.setProperty("--tau-viewport-height", `${fit.height}px`);
      root.style.setProperty("--tau-viewport-top", `${fit.top}px`);
      root.style.setProperty("--tau-keyboard-inset", `${inset}px`);
      document.body.toggleAttribute("data-keyboard", fit.keyboard);
      document.body.toggleAttribute("data-floating-toolbar", toolbar && inset > 0);
    };
    update();
    visual?.addEventListener("resize", update);
    visual?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      visual?.removeEventListener("resize", update);
      visual?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      root.style.removeProperty("--tau-viewport-height");
      root.style.removeProperty("--tau-viewport-top");
      root.style.removeProperty("--tau-keyboard-inset");
      document.body.removeAttribute("data-keyboard");
      document.body.removeAttribute("data-floating-toolbar");
    };
  }, [floatingToolbar]);

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
    let dismissing: string | undefined;
    let readerShown: string | undefined;
    const reconcileReader = () => {
      const route = latest.current.phone?.route;
      if (!route || !shown.current || !sameRoute(route, shown.current) || pending.current) return;
      const reader = phoneReaderFromState(window.history.state);
      const active = currentPhoneReader();
      if (active) {
        if (!claimPhoneReaderRoute(active.key, route)) { closePhoneReader(active.key); return; }
        if (reader?.key === active.key && sameRoute(reader.route, route)) { readerShown = active.key; return; }
        const next = stateWithPhoneReader(window.history.state, { key: active.key, route });
        if (reader && sameRoute(reader.route, route)) window.history.replaceState(next, "");
        else window.history.pushState(next, "");
        readerShown = active.key;
      } else if (reader && sameRoute(reader.route, route)) {
        pending.current = { back: 1, push: [] };
        window.history.go(-1);
      }
    };
    sync.current = () => {
      const to = latest.current.phone?.route;
      const from = shown.current;
      if (!to || !from || pending.current) return;
      if (sameRoute(from, to)) { reconcileReader(); return; }
      const reader = phoneReaderFromState(window.history.state);
      const steps = historySteps(from, to, reader?.route);
      shown.current = to;
      if (steps.back === 0) { write(steps); reconcileReader(); return; }
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
        if (dismissing) { closePhoneReader(dismissing); dismissing = undefined; }
        readerShown = undefined;
        sync.current();
        return;
      }
      // The user's back or forward, or a link that pushed an address.
      const stampedRoute = routeFromState(event.state);
      const route = stampedRoute ?? routeFromUrl(window.location.href);
      if (!stampedRoute) window.history.replaceState(stateWithRoute(event.state, route), "", urlWithRoute(window.location.href, route));
      if (readerShown && phoneReaderFromState(event.state)?.key !== readerShown) closePhoneReader(readerShown);
      readerShown = undefined;
      shown.current = route;
      apply(route);
    };
    const stopReader = coordinatePhoneReaderHistory({ changed: reconcileReader, dismiss: (key) => {
      const reader = phoneReaderFromState(window.history.state);
      const route = latest.current.phone?.route;
      if (!reader || reader.key !== key || !route || !sameRoute(reader.route, route) || pending.current) return false;
      dismissing = key;
      pending.current = { back: 1, push: [] };
      window.history.go(-1);
      return true;
    } });
    const stop = store.subscribe(() => { if (waiting) apply(waiting); });
    window.addEventListener("popstate", onPop);
    return () => {
      stop();
      stopReader();
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
