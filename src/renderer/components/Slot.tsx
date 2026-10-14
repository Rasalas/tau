import { useContext } from "react";
import type { SlotPlacement, WorkbenchActions } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { Region } from "./Regions";

/**
 * A place in a kit's own surface that other kits and the user's scripts fill
 * (API 1.62.0): every region registered at `name` draws here. Nothing while
 * none is, or outside a workbench; `bare` leaves out the container, for a slot inside a row.
 */
export function Slot({ name, actions, bare }: { name: SlotPlacement; actions: WorkbenchActions; bare?: boolean }) {
  const shell = useContext(WorkbenchShellContext);
  if (!shell) return null;
  return <Region registry={shell.registry} placement={name} actions={actions} {...(shell.snapshot ? { snapshot: shell.snapshot } : {})} {...(bare ? { bare } : {})} />;
}
