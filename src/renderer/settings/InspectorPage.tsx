import { useEffect, useState, useSyncExternalStore } from "react";
import type { ExtensionInspection, HostExtensionSummary } from "../../shared/contracts";
import type { ExtensionRegistry } from "../extension-system";
import { useHostClient } from "../host-client-context";
import { SystemPromptModal } from "../components/SystemPromptModal";
import { SettingRow, SettingsSection } from "./settings-layout";

/**
 * Development view over every extension the workbench knows: the desktop
 * registry, the host registry and the package folders on disk, with the
 * versions a package's `engines` is checked against.
 */
export function InspectorPage({ registry, cwd }: { registry: ExtensionRegistry; cwd?: string }) {
  const client = useHostClient();
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const [hostHalves, setHostHalves] = useState<HostExtensionSummary[]>([]);
  const [inspection, setInspection] = useState<ExtensionInspection>();
  const [error, setError] = useState<string>();
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    client?.listHostExtensions().then((summaries) => { if (!cancelled) setHostHalves(summaries); }).catch(() => undefined);
    if (cwd) {
      client?.inspectExtensions(cwd)
        .then((result) => { if (!cancelled) setInspection(result); })
        .catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure)); });
    }
    return () => { cancelled = true; };
  }, [client, cwd]);

  const desktop = registry.getExtensionSummaries();
  const unrendered = registry.getUnrenderedContributions();
  const problems = registry.getProblems();
  const ids = [...new Set([...desktop.map((entry) => entry.id), ...hostHalves.map((entry) => entry.id)])].sort();
  const packages = inspection?.packages ?? [];
  const hostStatus = (half: HostExtensionSummary | undefined) => !half ? "—" : half.error ? `failed: ${half.error}` : half.active ? `active${half.commands.length ? ` · ${half.commands.length} commands` : ""}` : "off";

  return (
    <div className="settings-page inspector-page">
      <p className="lede">Every extension both halves know, and the package folders on disk. Editing a package's files reloads it; /reload is for the rest.</p>

      <SettingsSection title="Versions">
        <SettingRow title="Tau" control={<code className="settings-value">{inspection?.versions.tau ?? "…"}</code>} />
        <SettingRow title="Pi" control={<code className="settings-value">{inspection?.versions.pi ?? "…"}</code>} />
        <SettingRow title="Extension API" control={<code className="settings-value">{inspection?.versions.api ?? "…"}</code>} />
      </SettingsSection>

      <SettingsSection title="Instructions">
        <SettingRow
          title="System prompt and persona"
          description="The active instructions, appended rules and the AGENTS.md context that was loaded."
          control={<button className="chrome-button" onClick={() => setSystemPromptOpen(true)}>View system prompt…</button>}
        />
      </SettingsSection>
      {systemPromptOpen ? <SystemPromptModal onClose={() => setSystemPromptOpen(false)} /> : null}

      <SettingsSection title="Loaded" plain>
        <table className="inspector-table" aria-label="Loaded extensions">
          <thead><tr><th>Extension</th><th>Desktop</th><th>Host</th><th>Isolation</th><th>Source</th></tr></thead>
          <tbody>
            {ids.map((id) => {
              const desktopHalf = desktop.find((entry) => entry.id === id);
              const hostHalf = hostHalves.find((entry) => entry.id === id);
              const pkg = packages.find((entry) => entry.id === id);
              return (
                <tr key={id} data-extension-id={id}>
                  <td><strong>{desktopHalf?.name ?? hostHalf?.name ?? id}</strong><small>{id}{pkg?.version ? ` · ${pkg.version}` : ""}</small></td>
                  <td>{desktopHalf ? (desktopHalf.active ? `active${desktopHalf.contributes ? ` · ${desktopHalf.contributes}` : ""}` : "off") : "—"}</td>
                  <td data-host-status={hostHalf?.error ? "failed" : hostHalf?.active ? "active" : "off"}>{hostStatus(hostHalf)}</td>
                  <td data-isolation={hostHalf?.isolation ?? pkg?.isolation ?? ""}>{hostHalf ? (hostHalf.isolation ?? "in-process") : "—"}</td>
                  <td>{pkg ? <span title={pkg.directory}>{pkg.scope} package</span> : "bundled"}</td>
                </tr>
              );
            })}
            {ids.length === 0 ? <tr><td colSpan={5}>No extension is loaded (safe mode).</td></tr> : null}
          </tbody>
        </table>
      </SettingsSection>

      {problems.length > 0 ? (
        <SettingsSection title="Problems" plain>
          {problems.map((problem, index) => (
            <div className="settings-note" data-level={problem.level ?? "error"} data-extension-id={problem.extensionId} key={`${problem.extensionId}:${index}`}>
              <strong>{problem.extensionName}</strong> · <code>{problem.source}</code>: {problem.message}
            </div>
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Not on this client" plain>
        <p className="lede">
          This client is the <b>{registry.getProfile()}</b> profile.
          {unrendered.length > 0 ? " These contributions are not drawn here; the extensions and their host halves keep running." : ""}
        </p>
        {unrendered.length > 0 ? (
          <table className="inspector-table" aria-label="Contributions not on this client">
            <thead><tr><th>Extension</th><th>Contribution</th><th>Renders on</th></tr></thead>
            <tbody>
              {unrendered.map((entry) => (
                <tr key={`${entry.extensionId}:${entry.kind}:${entry.id}`} data-extension-id={entry.extensionId}>
                  <td><strong>{entry.extensionName}</strong><small>{entry.extensionId}</small></td>
                  <td>{entry.kind}<small>{entry.label ?? entry.id}</small></td>
                  <td>{entry.profiles.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <div className="settings-note">It draws every contribution the active extensions offered.</div>}
      </SettingsSection>

      <SettingsSection title="Packages on disk" plain>
        {inspection?.directories.map((entry) => (
          <div className="inspector-folder" key={entry.directory}>
            <span>{entry.scope}</span>
            <code>{entry.directory}</code>
          </div>
        ))}
        {packages.length > 0 ? (
          <table className="inspector-table" aria-label="Extension packages">
            <thead><tr><th>Package</th><th>Entries</th><th>Engines</th><th>Permissions</th><th>Isolation</th><th>Source</th><th>Folder</th></tr></thead>
            <tbody>
              {packages.map((pkg) => (
                <tr key={pkg.directory}>
                  <td><strong>{pkg.name}</strong><small>{pkg.id}{pkg.version ? ` · ${pkg.version}` : ""}</small></td>
                  <td>{[pkg.desktop ? "desktop" : "", pkg.host ? "host" : ""].filter(Boolean).join(" + ")}</td>
                  <td>{pkg.engines ? Object.entries(pkg.engines).map(([engine, range]) => `${engine} ${range}`).join(", ") : "any"}</td>
                  <td>{pkg.permissions && pkg.permissions.length > 0 ? pkg.permissions.join(", ") : "none"}</td>
                  <td>{pkg.isolation ?? "worker"}</td>
                  <td>{pkg.source ? `${pkg.source.url}${pkg.source.commit ? ` (${pkg.source.commit.slice(0, 7)})` : ""}` : "—"}</td>
                  <td><code title={pkg.directory}>{pkg.directory.split("/").pop()}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : inspection ? <div className="settings-note">No package folder carries a tau-extension.json.</div> : null}
        {registry.getLoadFailures().map((failure) => (
          <div className="settings-note" data-level="error" key={`load:${failure.path}`}>
            {failure.path}: {failure.message.split("\n")[0]} — the version that was running stays until this builds.
          </div>
        ))}
        {inspection?.errors.map((failure) => (
          <div className="settings-note" data-level="error" key={failure.path}>{failure.path}: {failure.message}</div>
        ))}
        {inspection?.skipped.map((skip) => (
          <div className="settings-note" key={skip.directory}>{skip.directory}: {skip.reason}</div>
        ))}
        {error ? <div className="settings-note" data-level="error">Could not scan the package folders: {error}</div> : null}
        {!cwd ? <div className="settings-note">Open a project to scan its package folder.</div> : null}
      </SettingsSection>
    </div>
  );
}
