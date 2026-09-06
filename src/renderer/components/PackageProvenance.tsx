import { useCallback, useEffect, useState } from "react";
import type { ExtensionInspection } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";

/**
 * Where one extension came from, on its own settings page: core's own scan of
 * the package folders and the kits it ships. The verbs that change what is
 * installed belong to the Packages kit and live on its page.
 */
export function PackageProvenance({ id, cwd }: { id: string; cwd?: string }) {
  const client = useHostClient();
  const [pkg, setPkg] = useState<ExtensionInspection["packages"][number]>();
  const refresh = useCallback(() => {
    if (!client || !cwd) return;
    client.inspectExtensions(cwd)
      .then((result) => setPkg(result.packages.find((entry) => entry.id === id)))
      .catch(() => undefined);
  }, [client, cwd, id]);
  useEffect(refresh, [refresh]);

  if (!pkg) return null;
  return (
    <>
      <div className="settings-label">PACKAGE</div>
      <div className="inspector-folder"><span>version</span><code>{pkg.version ?? "not declared"}</code></div>
      <div className="inspector-folder"><span>signature</span><code>{pkg.signature?.label ?? "unsigned"}</code></div>
      <div className="inspector-folder"><span>isolation</span><code>{pkg.isolation === "in-process" ? "in-process (runs inside the host process)" : "worker"}</code></div>
      <div className="inspector-folder"><span>origin</span><code>{pkg.scope === "bundled" ? "bundled with Tau" : pkg.installedFrom ?? pkg.source?.url ?? pkg.directory}</code></div>
    </>
  );
}
