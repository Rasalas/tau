import { useCallback, useEffect, useState, type RefObject } from "react";
import { AppPageStore } from "../workbench/app-page-store";

/** How the new thread's project picker opens: the project in context, and whether it moves the draft on screen. */
export interface NewThreadPick {
  preselect?: string | undefined;
  carry?: boolean;
  /** A press on an element anchor leaves its popover alone, so the element can close it. */
  anchor?: RefObject<HTMLElement | null> | { x: number; y: number };
}

export function useAppOverlays() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** The command whose level the palette opened on, if any. */
  const [paletteMenu, setPaletteMenu] = useState<string>();
  const [newThreadPick, setNewThreadPick] = useState<NewThreadPick>();
  const [projectSourcesOpen, setProjectSourcesOpen] = useState(false);
  /** The source whose own view the project sources opened on, if any. */
  const [projectSource, setProjectSource] = useState<string>();
  const [activeOverlayId, setActiveOverlayId] = useState<string>();
  const [settingsPage, setSettingsPage] = useState<string>();
  const [pages] = useState(() => new AppPageStore());

  const openPalette = useCallback((options?: { menu?: string }) => {
    setPaletteMenu(options?.menu);
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openNewThreadPicker = useCallback((pick: NewThreadPick = {}) => setNewThreadPick(pick), []);
  const closeNewThreadPicker = useCallback(() => setNewThreadPick(undefined), []);
  const openProjectSources = useCallback((source?: string) => {
    setNewThreadPick(undefined);
    setProjectSource(source);
    setProjectSourcesOpen(true);
  }, []);
  const closeProjectSources = useCallback(() => setProjectSourcesOpen(false), []);
  const openOverlay = useCallback((id: string) => setActiveOverlayId(id), []);
  const closeOverlay = useCallback(() => setActiveOverlayId(undefined), []);

  return {
    paletteOpen,
    paletteMenu,
    setPaletteOpen,
    openPalette,
    closePalette,
    newThreadOpen: newThreadPick !== undefined,
    newThreadPick,
    openNewThreadPicker,
    closeNewThreadPicker,
    projectSourcesOpen,
    projectSource,
    setProjectSourcesOpen,
    openProjectSources,
    closeProjectSources,
    activeOverlayId,
    setActiveOverlayId,
    openOverlay,
    closeOverlay,
    settingsPage,
    setSettingsPage,
    pages,
  };
}

/** A registered conversation view on screen, and the thread it belongs to. */
export interface OpenConversationView {
  sessionId: string;
  id: string;
  params: Readonly<Record<string, unknown>>;
}

/** The view shown in place of `threadId`'s transcript; coming back to that thread shows its transcript. */
export function useConversationView(threadId: string | undefined) {
  const [opened, setOpened] = useState<OpenConversationView>();
  const openConversationView = useCallback((id: string, params: Record<string, unknown> = {}) => {
    if (threadId) setOpened({ sessionId: threadId, id, params });
  }, [threadId]);
  const closeConversationView = useCallback(() => setOpened(undefined), []);
  useEffect(() => {
    setOpened((current) => current?.sessionId === threadId ? current : undefined);
  }, [threadId]);
  const conversationView = opened?.sessionId === threadId ? opened : undefined;
  return { conversationView, openConversationView, closeConversationView };
}
