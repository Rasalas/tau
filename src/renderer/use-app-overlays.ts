import { useCallback, useState } from "react";
import { AppPageStore } from "../workbench/app-page-store";

export function useAppOverlays() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** The command whose level the palette opened on, if any. */
  const [paletteMenu, setPaletteMenu] = useState<string>();
  const [newThreadOpen, setNewThreadOpen] = useState(false);
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
  const openNewThreadPicker = useCallback(() => setNewThreadOpen(true), []);
  const closeNewThreadPicker = useCallback(() => setNewThreadOpen(false), []);
  const openProjectSources = useCallback((source?: string) => {
    setNewThreadOpen(false);
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
    newThreadOpen,
    setNewThreadOpen,
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
