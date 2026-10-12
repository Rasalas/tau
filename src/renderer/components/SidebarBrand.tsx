import { useEffect, useState } from "react";
import type { WindowShellStatus } from "../../shared/window-shell";
import { useHostClient } from "../host-client-context";
import { TauMark } from "./TauMark";

/**
 * The τ beside macOS's traffic lights, in the sidebar's title bar strip. The
 * app's name is in the menu bar already; only Tau Dev says what it is.
 */
export function SidebarBrand() {
  const client = useHostClient();
  const [devBuild, setDevBuild] = useState(false);
  useEffect(() => {
    let live = true;
    void client?.windowAction({ kind: "status" }).then((answer) => {
      if (live) setDevBuild((answer as WindowShellStatus | undefined)?.devBuild === true);
    }, () => undefined);
    return () => { live = false; };
  }, [client]);
  return <div className="sidebar-brand">
    <TauMark className="sidebar-brand-mark" />
    {devBuild ? <span className="sidebar-brand-dev">Dev</span> : null}
  </div>;
}
