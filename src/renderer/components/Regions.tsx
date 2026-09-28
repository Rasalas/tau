import { Suspense, useSyncExternalStore, type ReactNode } from "react";
import type { ExtensionRegistry, LookInRegionContext, RegionPlacement, WorkbenchActions } from "../extension-system";
import type { HostSnapshot } from "../../shared/contracts";
import { LazyFeatureBoundary, LazyFeatureFallback } from "./LazyFeature";

interface RegionHostProps {
  registry: ExtensionRegistry;
  placement: RegionPlacement;
  snapshot?: HostSnapshot;
  actions: WorkbenchActions;
  lookIn?: LookInRegionContext;
}

/**
 * Renders whatever extensions registered for one placement; nothing when empty.
 * `lead` and `children` are core's own controls, drawn before and after the contributions.
 */
export function Region({ registry, placement, snapshot, actions, lookIn, lead, children }: RegionHostProps & { lead?: ReactNode; children?: ReactNode }) {
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const regions = registry.getRegions(placement);
  if (regions.length === 0 && children === undefined && !lead) return null;
  return (
    <div className={`workbench-region region-${placement}`} data-placement={placement} role="group">
      {lead}
      {regions.map((region) => (
        <LazyFeatureBoundary
          key={region.id}
          label={region.id}
          extensionId={region.extensionId}
          extensionName={region.extensionName}
          registry={registry}
          onNotify={actions.notify}
        >
          <Suspense fallback={<LazyFeatureFallback label={region.id} />}>
            <region.Component snapshot={snapshot} actions={actions} {...(lookIn ? { lookIn } : {})} />
          </Suspense>
        </LazyFeatureBoundary>
      ))}
      {children}
    </div>
  );
}

/** Pi's footer, assembled from status items; hidden until an extension contributes one. */
export function StatusLine({ registry, snapshot, actions }: Omit<RegionHostProps, "placement">) {
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const items = registry.getStatusItems();
  if (items.length === 0) return null;
  const side = (align: "left" | "right") => items
    .filter((item) => (item.align ?? "left") === align)
    .map((item) => (
      <LazyFeatureBoundary
        key={item.id}
        label={item.id}
        extensionId={item.extensionId}
        extensionName={item.extensionName}
        registry={registry}
        onNotify={actions.notify}
      >
        <Suspense fallback={null}>
          <span className="status-item"><item.Component snapshot={snapshot} actions={actions} /></span>
        </Suspense>
      </LazyFeatureBoundary>
    ));
  return (
    <footer className="status-line" aria-label="Status line">
      <span className="status-side">{side("left")}</span>
      <span className="spacer" />
      <span className="status-side">{side("right")}</span>
    </footer>
  );
}
