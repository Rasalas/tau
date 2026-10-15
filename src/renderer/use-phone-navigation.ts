import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AppPageStore } from "../workbench/app-page-store";
import { PHONE_HOME, type PhoneRoute, type PhoneTab } from "../workbench/phone-route";

export type SettingsView = "sections" | "page";

export interface PhoneNavigation {
  /** Where the phone is; the history and the bottom navigation follow it. */
  route: PhoneRoute;
  /** The chat is on screen, over the list. */
  chatShown: boolean;
  showChat(): void;
  showList(): void;
  toggleChat(): void;
  /** Settings' own level on a phone: its list of sections, or one of them. */
  settingsView: SettingsView;
  setSettingsView(view: SettingsView): void;
  /** Opens Settings, at one section when named. */
  openSettings(section?: string): void;
  /** A destination of the bottom navigation. */
  openTab(tab: PhoneTab): void;
  /** What the system's back or a link asks for. */
  applyRoute(route: PhoneRoute): void;
}

/**
 * A phone's navigation over the workbench's own state: the list is home, a
 * chat is a sub-page, an app page and Settings are the other main pages.
 * Only the phone form reads it; elsewhere the chat is always shown.
 */
export function usePhoneNavigation({ phone, pages, settingsPage, setSettingsPage, sessionId, drafting }: {
  phone: boolean;
  pages: AppPageStore;
  settingsPage: string | undefined;
  setSettingsPage(page: string | undefined): void;
  sessionId: string | undefined;
  drafting: boolean;
}): PhoneNavigation {
  const [chat, setChat] = useState(false);
  const [settingsView, setSettingsView] = useState<SettingsView>("sections");
  const openPage = useSyncExternalStore(pages.subscribe, pages.getSnapshot);
  // A new thread's draft is a chat; it opens from the list's button, a shortcut or the palette.
  const drafted = useRef(drafting);
  useEffect(() => {
    if (drafting && !drafted.current) setChat(true);
    drafted.current = drafting;
  }, [drafting]);
  // Closed Settings opens at its sections again.
  useEffect(() => { if (!settingsPage) setSettingsView("sections"); }, [settingsPage]);

  const route = useMemo<PhoneRoute>(() => {
    if (settingsPage) return settingsView === "page" ? { kind: "settings", section: settingsPage } : { kind: "settings" };
    if (openPage) return { kind: "page", page: openPage.id, depth: openPage.views.length - 1 };
    if (chat) return drafting || !sessionId ? { kind: "chat" } : { kind: "chat", thread: sessionId };
    return PHONE_HOME;
  }, [chat, drafting, openPage, sessionId, settingsPage, settingsView]);

  const settingsRef = useRef(settingsPage);
  settingsRef.current = settingsPage;
  const leaveMainPages = useCallback(() => { setSettingsPage(undefined); pages.close(); }, [pages, setSettingsPage]);
  const openSettings = useCallback((section?: string) => {
    pages.close();
    setSettingsView(section ? "page" : "sections");
    setSettingsPage(section ?? settingsRef.current ?? "general");
  }, [pages, setSettingsPage]);

  const applyRoute = useCallback((next: PhoneRoute) => {
    switch (next.kind) {
      case "threads": leaveMainPages(); setChat(false); return;
      case "chat": leaveMainPages(); setChat(true); return;
      case "settings": openSettings(next.section); return;
      case "page": {
        setSettingsPage(undefined);
        const open = pages.getSnapshot();
        if (open?.id !== next.page) { pages.open(next.page); return; }
        for (let extra = open.views.length - 1 - next.depth; extra > 0; extra -= 1) pages.back();
      }
    }
  }, [leaveMainPages, openSettings, pages, setSettingsPage]);

  const openTab = useCallback((tab: PhoneTab) => {
    if (tab.kind === "threads") { leaveMainPages(); setChat(false); return; }
    if (tab.kind === "settings") { openSettings(); return; }
    setSettingsPage(undefined);
    if (pages.getSnapshot()?.id !== tab.page) pages.open(tab.page);
  }, [leaveMainPages, openSettings, pages, setSettingsPage]);

  return {
    route: phone ? route : PHONE_HOME,
    chatShown: !phone || chat,
    showChat: useCallback(() => setChat(true), []),
    showList: useCallback(() => setChat(false), []),
    toggleChat: useCallback(() => setChat((shown) => !shown), []),
    settingsView,
    setSettingsView,
    openSettings,
    openTab,
    applyRoute,
  };
}
