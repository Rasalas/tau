import { useCallback, useEffect, useState } from "react";
import type { ExtensionInspection } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";
import { SettingRow, SettingsSection } from "../settings/settings-layout";

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
    <SettingsSection title="Package">
      <SettingRow title="Version" control={<code className="settings-value">{pkg.version ?? "not declared"}</code>} />
      <SettingRow title="Signature" control={<code className="settings-value">{pkg.signature?.label ?? "unsigned"}</code>} />
      <SettingRow title="Isolation" control={<code className="settings-value">{pkg.isolation === "in-process" ? "in-process (runs inside the host process)" : "worker"}</code>} />
      <SettingRow title="Origin" control={<code className="settings-value">{pkg.scope === "bundled" ? "bundled with Tau" : pkg.installedFrom ?? pkg.source?.url ?? pkg.directory}</code>} />
    </SettingsSection>
  );
}
