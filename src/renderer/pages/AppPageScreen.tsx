import { Suspense, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft } from "lucide-react";
import type { ExtensionRegistry, PageProps, WorkbenchActions } from "../extension-system";
import type { AppPageStore } from "../../workbench/app-page-store";
import { LazyFeatureBoundary, LazyFeatureFallback } from "../components/LazyFeature";
import { WindowControlsInset } from "../components/WindowControlsInset";
import { openOverlays } from "../keybinding-context";
import "../settings/settings.css";
import "./app-page.css";

/**
 * A page `registerPage` added, in Settings' frame: a bar with the page and the
 * views it stepped into, the page below. On a desktop it sits beside the
 * sidebar, whose foot has Back; on a phone it is a screen with its own back.
 * Escape steps out of a view, then leaves the page.
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

  return (
    <section className={`app-page${stacked ? " stacked" : ""}${navShown ? " with-nav" : ""}`} aria-label={label} data-app-page={state.id}>
      <main className="settings-main" ref={mainRef} tabIndex={-1}>
        <header className="settings-topbar app-page-bar">
          {stacked ? null : sidebarShown ? null : <WindowControlsInset />}
          {showBack ? (
            <button type="button" className="app-page-back" aria-label={trail.length > 0 ? `Back to ${label}` : "Back"} onClick={back}>
              {stacked ? <ChevronLeft size={18} /> : <><ArrowLeft size={15} /><span>Back</span></>}
            </button>
          ) : null}
          <nav aria-label="Page">
            <ol>
              <li className={`settings-crumb${trail.length === 0 ? " current" : ""}`} {...(trail.length === 0 ? { "aria-current": "page" as const } : {})}>
                {trail.length === 0 ? <h1>{label}</h1> : <button type="button" onClick={store.root}>{label}</button>}
              </li>
              {trail.map((entry, index) => {
                const last = index === trail.length - 1;
                return [
                  <li key={`s${index}`} className="settings-crumb-separator" aria-hidden>/</li>,
                  <li key={`c${index}`} className={`settings-crumb${last ? " current" : ""}`} {...(last ? { "aria-current": "page" as const } : {})}>
                    {last ? <h1>{entry.label ?? label}</h1> : <span>{entry.label ?? label}</span>}
                  </li>,
                ];
              })}
            </ol>
          </nav>
        </header>
        <div className={page?.layout === "fill" ? "app-page-fill" : "settings-scroll"}>
          <div className={page?.layout === "fill" ? "app-page-fill" : `settings-content app-page-content${page?.layout === "wide" ? " wide" : ""}`} data-page={state.id}>
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
          </div>
        </div>
      </main>
      {navShown ? nav : null}
    </section>
  );
}
