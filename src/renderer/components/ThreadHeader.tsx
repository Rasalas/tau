import type { ReactNode } from "react";
import { GitBranch } from "lucide-react";
import type { HostSnapshot } from "../../shared/contracts";
import { tooltipProps } from "./ui/Tooltip";
import { Region, RegionOr } from "./Regions";
import type { ExtensionRegistry, WorkbenchActions } from "../extension-system";

/** Where kits add to the sub-line: `thread-details` items, and a `thread-branch` that replaces core's label. */
export interface ThreadDetailSlots {
  registry: ExtensionRegistry;
  actions: WorkbenchActions;
}

/** The kits' items, then their branch or core's plain one. */
function SlotDetails({ slots, snapshot, branch }: { slots?: ThreadDetailSlots; snapshot?: HostSnapshot; branch?: string }) {
  const plain = branch ? <span className="thread-detail thread-detail-branch" {...tooltipProps(branch, { side: "bottom", when: "truncated" })}>
    <GitBranch size={12} aria-hidden /><span>{branch}</span>
  </span> : null;
  if (!slots) return plain;
  return <>
    <Region bare registry={slots.registry} placement="thread-details" snapshot={snapshot} actions={slots.actions} />
    <RegionOr bare registry={slots.registry} placement="thread-branch" snapshot={snapshot} actions={slots.actions} fallback={plain} />
  </>;
}

/** The start screen's sub-line: an empty thread's branch, or what a kit says of a draft (design 1k). */
export function StartDetails({ snapshot, slots }: { snapshot?: HostSnapshot; slots?: ThreadDetailSlots }) {
  return <div className="thread-details"><SlotDetails slots={slots} snapshot={snapshot} {...(snapshot?.projectLabel ? { branch: snapshot.projectLabel } : {})} /></div>;
}

/**
 * The conversation's own head, where the window-wide title bar was: the
 * thread's title and details, what kits place at its end, and the stage's
 * tools. It is the window's drag region over the conversation.
 */
export function ThreadHeader({ lead, title, details, actions, tools }: {
  /** Before the title: room for the traffic lights, a tablet's threads toggle. */
  lead?: ReactNode;
  title: ReactNode;
  details?: ReactNode;
  /** The `title-bar` region's slot. */
  actions?: ReactNode;
  /** The stage strip's tools, here while the stage is hidden (design 1k). */
  tools?: ReactNode;
}) {
  return <header className="thread-header">
    {lead ? <div className="thread-header-lead thread-header-content">{lead}</div> : null}
    <div className="thread-heading thread-header-content">
      <div className="thread-heading-title">{title}</div>
      {details}
    </div>
    <div className="thread-header-actions thread-header-content">{actions}</div>
    {tools ? <div className="thread-header-tools thread-header-content" role="toolbar" aria-label="Tools">{tools}</div> : null}
  </header>;
}
