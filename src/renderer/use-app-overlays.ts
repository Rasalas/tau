import { useCallback, useState } from "react";
import { AppPageStore } from "../workbench/app-page-store";

/** How the new thread's project picker opens: the project in context, and whether it moves the draft on screen. */
export interface NewThreadPick {
  preselect?: string | undefined;
  carry?: boolean;
  anchor?: { x: number; y: number };
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
