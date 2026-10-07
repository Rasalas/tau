import { useEffect, useState } from "react";
import type { WindowShellStatus } from "../../shared/window-shell";
import { useHostClient } from "../host-client-context";

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
    {/* assets/icon/mark-dark.svg, as kits/onboarding/mark.tsx draws it. */}
    <svg className="sidebar-brand-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" />
      <path d="M8.7 10L22.52 10" />
      <path d="M15 10L15 19.15C15 21.29 16.74 23.03 18.88 23.03C20.33 23.03 21.04 22.63 22.03 21.94" />
    </svg>
    {devBuild ? <span className="sidebar-brand-dev">Dev</span> : null}
  </div>;
}
