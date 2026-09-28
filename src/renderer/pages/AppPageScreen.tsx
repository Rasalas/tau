import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft } from "lucide-react";
import type { ExtensionRegistry, PageProps, WorkbenchActions } from "../extension-system";
import type { AppPageStore } from "../../workbench/app-page-store";
import { LazyFeatureBoundary, LazyFeatureFallback } from "../components/LazyFeature";
import { WindowControlsInset } from "../components/WindowControlsInset";
import { openOverlays } from "../keybinding-context";
import { SettingsPageActionSlot } from "../settings/page-action";
import { SettingsPageHead, type SettingsCrumb } from "../settings/page-head";
import "../settings/settings.css";
import "./app-page.css";

/**
 * A page `registerPage` added, in Settings' frame: Settings' page head (title,
 * description, action; the views above as a breadcrumb), the page below. On a
 * desktop it sits beside the sidebar, whose foot has Back; on a phone it is a
 * screen with its own back and the title in its bar. Escape steps out of a
 * view, then leaves the page.
 */
export function AppPageScreen({ registry, store, actions, stacked = false, sidebarShown = true, nav }: {
  registry: ExtensionRegistry;
  store: AppPageStore;
  actions: WorkbenchActions;
  /** A phone: the whole screen, with a back button in the bar. */
  stacked?: boolean;
  /** Without the sidebar beside it the bar carries Back, and keeps clear of the window controls. */
  sidebarShown?: boolean;
  /** A phone's bottom navigation: the page is a main page, with no Back of its own until it steps into a view. */
  nav?: ReactNode;
}) {
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const page = registry.getPage(state?.id);
  const views = state?.views ?? [];
  const view = views.at(-1);
  const mainRef = useRef<HTMLElement>(null);
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);

  const back = () => { if (!store.back()) store.close(); };
  const props = useMemo<Omit<PageProps, "params">>(() => ({
    actions,
    navigate: (params, options) => store.navigate(params, options),
    close: store.close,
  }), [actions, store]);

  useEffect(() => { mainRef.current?.focus({ preventScroll: true }); }, [state?.id]);

  useEffect(() => {
    // Read as the key goes down: an overlay over the page that closes itself on this Escape is gone by the bubble.
    const overlaid = new WeakSet<KeyboardEvent>();
    const early = (event: KeyboardEvent) => {
      if (event.key === "Escape" && openOverlays().some((element) => !element.matches("[data-app-page]"))) overlaid.add(event);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A dialog, menu or popover over the page closes first.
      if (overlaid.has(event)) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        target.blur();
        return;
      }
      event.preventDefault();
      if (!store.back()) store.close();
    };
    window.addEventListener("keydown", early, true);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", early, true);
      window.removeEventListener("keydown", keydown);
    };
  }, [store]);

  if (!state) return null;
  const label = page?.label ?? "Page";
  const trail = views.slice(1);
  const showBack = nav ? trail.length > 0 : stacked || !sidebarShown;
  const navShown = Boolean(nav) && trail.length === 0;
  const title = trail.length > 0 ? trail.at(-1)?.label ?? label : label;
  // Every view below the one on screen, the page first; a crumb steps back to its view.
  const crumbs: SettingsCrumb[] = trail.length === 0 ? [] : [label, ...trail.slice(0, -1).map((entry) => entry.label ?? label)].map((crumb, index) => ({
    label: crumb,
    open: index === 0 ? store.root : () => { for (let step = trail.length - index; step > 0; step--) store.back(); },
  }));
  const fill = page?.layout === "fill";
  const head = (
    <SettingsPageHead
      title={stacked ? undefined : title}
      description={trail.length === 0 ? page?.description : undefined}
      crumbs={stacked ? [] : crumbs}
      actionSlot={setActionSlot}
    />
  );

  return (
    <section className={`app-page${stacked ? " stacked" : ""}${navShown ? " with-nav" : ""}`} aria-label={label} data-app-page={state.id}>
      <main className="settings-main" ref={mainRef} tabIndex={-1}>
        <header className="settings-topbar app-page-bar">
          {stacked ? null : sidebarShown ? null : <WindowControlsInset />}
          {showBack ? (
            <button type="button" className="app-page-back" aria-label={trail.length > 0 ? `Back to ${crumbs.at(-1)?.label ?? label}` : "Back"} onClick={back}>
              {stacked ? <ChevronLeft size={18} /> : <><ArrowLeft size={15} /><span>Back</span></>}
            </button>
          ) : null}
          {stacked ? <h1 className="settings-topbar-title">{title}</h1> : null}
        </header>
        {fill ? <div className="app-page-head">{head}</div> : null}
        <div className={fill ? "app-page-fill" : "settings-scroll"}>
          <div className={fill ? "app-page-fill" : `settings-content app-page-content${page?.layout === "wide" ? " wide" : ""}`} data-page={state.id}>
            {fill ? null : head}
            <SettingsPageActionSlot.Provider value={actionSlot}>
              {page ? (
                <LazyFeatureBoundary
                  key={page.id}
                  label={page.id}
                  extensionId={page.extensionId}
                  extensionName={page.extensionName}
                  registry={registry}
                  onNotify={actions.notify}
                >
                  <Suspense fallback={<LazyFeatureFallback label={page.label} />}>
                    <page.Component {...props} params={view?.params ?? {}} />
                  </Suspense>
                </LazyFeatureBoundary>
              ) : (
                <p className="lede">This page is gone; its extension may have been turned off.</p>
              )}
            </SettingsPageActionSlot.Provider>
          </div>
        </div>
      </main>
      {navShown ? nav : null}
    </section>
  );
}
