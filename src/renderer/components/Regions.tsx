import { Suspense, useSyncExternalStore, type ReactNode } from "react";
import type { ExtensionRegistry, LookInRegionContext, RegionPlacement, RegionProps, SlotPlacement, TranscriptTurn, WorkbenchActions } from "../extension-system";
import type { HostSnapshot } from "../../shared/contracts";
import { LazyFeatureBoundary, LazyFeatureFallback } from "./LazyFeature";
import { Part, partName } from "../customization";

interface RegionHostProps {
  workspaceSummary?: RegionProps["workspaceSummary"];
  workspacePreviewAvailable?: boolean;
  registry: ExtensionRegistry;
  placement: RegionPlacement | SlotPlacement;
  snapshot?: HostSnapshot;
  actions: WorkbenchActions;
  lookIn?: LookInRegionContext;
  turn?: TranscriptTurn;
}

/**
 * Renders whatever extensions registered for one placement; nothing when empty.
 * `lead` and `children` are core's own controls, drawn before and after the contributions.
 */
export function Region({ registry, placement, snapshot, actions, lookIn, turn, workspacePreviewAvailable, workspaceSummary, lead, children, bare }: RegionHostProps & { lead?: ReactNode; children?: ReactNode; bare?: boolean }) {
  useSyncExternalStore(registry.subscribeRegistrations, registry.getRegistrationVersion);
  const regions = registry.getRegions(placement);
  if (regions.length === 0 && children === undefined && !lead) return null;
  const drawn = <>
    {lead}
    {regions.map((region) => (
      <Part key={region.id} name={partName("region", region.id)} extensionId={region.extensionId}>
      <LazyFeatureBoundary
        label={region.id}
        extensionId={region.extensionId}
        extensionName={region.extensionName}
        registry={registry}
        onNotify={actions.notify}
      >
        <Suspense fallback={<LazyFeatureFallback label={region.id} />}>
          <region.Component snapshot={snapshot} actions={actions} {...(workspaceSummary ? { workspaceSummary } : {})} {...(workspacePreviewAvailable !== undefined ? { workspacePreviewAvailable } : {})} {...(lookIn ? { lookIn } : {})} {...(turn ? { turn } : {})} />
        </Suspense>
      </LazyFeatureBoundary>
      </Part>
    ))}
    {children}
  </>;
  // Bare: the contributions are the container's own children (a header's sub-line).
  // A kit's slot (`tau.usage/page-end`) is a class name only after its slash and dots become dashes.
  return bare ? drawn : <div className={`workbench-region region-${placement.replace(/[^a-z0-9-]/gu, "-")}`} data-placement={placement} role="group">{drawn}</div>;
}

/** A placement kits may take over from core: their contributions while any is registered, else `fallback`. */
export function RegionOr({ fallback, ...props }: RegionHostProps & { fallback: ReactNode; bare?: boolean }) {
  useSyncExternalStore(props.registry.subscribeRegistrations, props.registry.getRegistrationVersion);
  return props.registry.getRegions(props.placement).length > 0 ? <Region {...props} /> : fallback;
}

/** Pi's footer, assembled from status items; hidden until an extension contributes one. */
export function StatusLine({ registry, snapshot, actions }: Omit<RegionHostProps, "placement">) {
  useSyncExternalStore(registry.subscribeRegistrations, registry.getRegistrationVersion);
  const items = registry.getStatusItems();
  if (items.length === 0) return null;
  const side = (align: "left" | "right") => items
    .filter((item) => (item.align ?? "left") === align)
    .map((item) => (
      <Part key={item.id} name={partName("status", item.id)} extensionId={item.extensionId}>
      <LazyFeatureBoundary
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
      </Part>
    ));
  return (
    <footer className="status-line" aria-label="Status line">
      <span className="status-side">{side("left")}</span>
      <span className="spacer" />
      <span className="status-side">{side("right")}</span>
    </footer>
  );
}
