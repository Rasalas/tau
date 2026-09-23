import { memo, Suspense, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2 } from "lucide-react";
import type { ExtensionRegistry, PanelPlacement, PanelProps, WorkbenchActions } from "../extension-system";
import { LazyFeatureBoundary, LazyFeatureFallback } from "./LazyFeature";
import { tooltipProps } from "./ui/Tooltip";

export const MountedPanel = memo(function MountedPanel({
  Component,
  active,
  placement,
  label,
  extensionId,
  extensionName,
  registry,
  actions,
  onNotify,
}: {
  Component: ComponentType<PanelProps>;
  active: boolean;
  placement?: PanelPlacement;
  label: string;
  extensionId?: string;
  extensionName: string;
  registry?: ExtensionRegistry;
  actions: WorkbenchActions;
  onNotify?(message: string): void;
}) {
  return <div className={active ? "panel active" : "panel"}>
    <LazyFeatureBoundary
      label={label.toLowerCase()}
      extensionId={extensionId}
      extensionName={extensionName}
      registry={registry}
      onNotify={onNotify}
    >
      <Suspense fallback={<LazyFeatureFallback label={label.toLowerCase()} />}>
        <Component active={active} extensionName={extensionName} actions={actions} {...(placement ? { placement } : {})} />
      </Suspense>
    </LazyFeatureBoundary>
  </div>;
});

/**
 * One DOM element per panel for its whole life. The panel renders into it
 * through a portal, and the element moves between the dock, the drawer and
 * the stage, so a move never remounts the panel.
 */
export function usePanelHosts(): (id: string) => HTMLElement {
  const [hosts] = useState(() => new Map<string, HTMLElement>());
  return (id) => {
    let host = hosts.get(id);
    if (!host) {
      host = document.createElement("div");
      host.className = "panel-host";
      host.dataset.panelId = id;
      hosts.set(id, host);
    }
    return host;
  };
}

/** The panel's content, rendered into its host wherever that host is attached. */
export function PanelPortal({ host, children }: { host: HTMLElement; children: React.ReactNode }) {
  return createPortal(children, host);
}

/** Where a panel's host is shown; mounting adopts the host, unmounting lets it go. */
export function PanelSlot({ host }: { host: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return undefined;
    slot.appendChild(host);
    return () => { if (host.parentNode === slot) slot.removeChild(host); };
  }, [host]);
  return <div ref={ref} className="panel-slot" />;
}

/** Maximize into a stage tab, or back out of one; sits over the panel header's end. */
export function PanelMaximizeButton({ label, maximized, shortcut, onToggle }: { label: string; maximized: boolean; shortcut?: string; onToggle(): void }) {
  const text = maximized ? `Move ${label} back` : `Open ${label} as a tab`;
  return <button
    type="button"
    className="icon-button panel-maximize"
    aria-label={text}
    {...tooltipProps(text, { side: "bottom", shortcut })}
    onClick={onToggle}
  >{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>;
}
