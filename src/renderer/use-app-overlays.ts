import { useCallback, useState } from "react";

export function useAppOverlays() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const [projectSourcesOpen, setProjectSourcesOpen] = useState(false);
  const [activeOverlayId, setActiveOverlayId] = useState<string>();
  const [settingsPage, setSettingsPage] = useState<string>();

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openNewThreadPicker = useCallback(() => setNewThreadOpen(true), []);
  const closeNewThreadPicker = useCallback(() => setNewThreadOpen(false), []);
  const openProjectSources = useCallback(() => setProjectSourcesOpen(true), []);
  const closeProjectSources = useCallback(() => setProjectSourcesOpen(false), []);
  const openOverlay = useCallback((id: string) => setActiveOverlayId(id), []);
  const closeOverlay = useCallback(() => setActiveOverlayId(undefined), []);

  return {
    paletteOpen,
    setPaletteOpen,
    openPalette,
    closePalette,
    newThreadOpen,
    setNewThreadOpen,
    openNewThreadPicker,
    closeNewThreadPicker,
    projectSourcesOpen,
    setProjectSourcesOpen,
    openProjectSources,
    closeProjectSources,
    activeOverlayId,
    setActiveOverlayId,
    openOverlay,
    closeOverlay,
    settingsPage,
    setSettingsPage,
  };
}
