import { useSyncExternalStore, type ComponentType } from "react";
import type { UiSession } from "tau";
import type { ThreadRowAccessoryProps, TurnStat } from "./protocol.js";
import { useWorkspaceStore } from "./store-context.js";

/** The last turn's `+N −N`, left out for a settled thread; the rail and the phone's list draw it alike. */
export function diffStat(stat: TurnStat | undefined, settled: boolean) {
  if (!stat || settled) return null;
  return <span key="diff" className="thread-diff-stat" aria-label={`Last turn: ${stat.added} lines added, ${stat.removed} removed`}><b>+{stat.added}</b> <i>−{stat.removed}</i></span>;
}

/** Every kit's mark for a thread (`registerThreadRowAccessory`). */
export function accessoryMarks(accessories: ReadonlyArray<ComponentType<ThreadRowAccessoryProps>>, session: UiSession) {
  return accessories.map((Accessory, index) => <Accessory key={index} session={session} />);
}

/** The rail's marks on a row of the phone's list, which core draws and this kit fills. */
export function RowMarks({ session, settled }: { session: UiSession; settled: boolean }) {
  const workspace = useWorkspaceStore();
  const accessories = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().threadRowAccessories);
  const stat = useSyncExternalStore(workspace.subscribe, () => workspace.getSnapshot().turnStats[session.id]);
  return <>{diffStat(stat, settled)}{accessoryMarks(accessories, session)}</>;
}
