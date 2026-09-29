import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ExtensionInspection, HostExtensionSummary } from "../../shared/contracts";
import type { ExtensionRegistry } from "../extension-system";
import { useHostClient } from "../host-client-context";
import { SystemPromptModal } from "../components/SystemPromptModal";
import { errorMessage } from "../../workbench/error-message";
import { Badge, Button, HelpTip, SettingsState, ValueList } from "./controls";
import { SettingRow, SettingsSection } from "./settings-layout";
import { settingAnchor } from "./settings-search";

/** A half's state in a word, with what it adds after it. */
function HalfState({ state, detail }: { state: "active" | "off" | "failed" | undefined; detail?: string | undefined }) {
  if (!state) return <span className="inspector-none">—</span>;
  return (
    <span className="inspector-state">
      <Badge tone={state === "active" ? "success" : state === "failed" ? "danger" : "neutral"}>{state === "active" ? "Active" : state === "failed" ? "Failed" : "Off"}</Badge>
      {detail ? <small>{detail}</small> : null}
    </span>
  );
}

/** One line of what went wrong or was left out, with how bad it is in a word. */
function Finding({ tone, label, children, ...data }: { tone: "danger" | "warn" | "neutral"; label: string; children: ReactNode; "data-extension-id"?: string }) {
  return (
    <div className="inspector-finding" {...data}>
      <Badge tone={tone}>{label}</Badge>
      <p>{children}</p>
    </div>
  );
}

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
  const [attempt, setAttempt] = useState(0);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    client?.listHostExtensions().then((summaries) => { if (!cancelled) setHostHalves(summaries); }).catch(() => undefined);
    if (cwd) {
      client?.inspectExtensions(cwd)
        .then((result) => { if (!cancelled) setInspection(result); })
        .catch((failure: unknown) => { if (!cancelled) setError(errorMessage(failure)); });
    }
    return () => { cancelled = true; };
  }, [client, cwd, attempt]);
  const retry = () => setAttempt((count) => count + 1);

  const desktop = registry.getExtensionSummaries();
  const unrendered = registry.getUnrenderedContributions();
  const problems = registry.getProblems();
  const loadFailures = registry.getLoadFailures();
  const ids = [...new Set([...desktop.map((entry) => entry.id), ...hostHalves.map((entry) => entry.id)])].sort();
  const packages = inspection?.packages ?? [];
  const noProject = <SettingsState kind="empty" title="No project open" description="Open a project to read the versions and scan its package folder." />;

  return (
    <div className="settings-page inspector-page">
      <p className="lede">Editing a package's files reloads it; /reload is for the rest.</p>

      <SettingsSection title="Versions" id={settingAnchor("Versions")} plain>
        {inspection ? (
          <ValueList label="Versions" items={[
            { label: "Tau", value: inspection.versions.tau, mono: true, copy: inspection.versions.tau },
            { label: "Pi", value: inspection.versions.pi, mono: true, copy: inspection.versions.pi },
            { label: "Extension API", value: inspection.versions.api, mono: true, copy: inspection.versions.api },
            ...(inspection.distribution ? [{ label: "Kits", value: `${inspection.distribution.name} ${inspection.distribution.version}`, mono: true }] : []),
          ]} />
        ) : error ? <SettingsState kind="empty" title="The versions are not known" description="They come with the scan of the package folders, which failed: see Packages on disk." />
          : !cwd ? noProject : <SettingsState kind="loading" title="Reading the versions" rows={3} />}
      </SettingsSection>

      <SettingsSection title="Instructions">
        <SettingRow
          id={settingAnchor("System prompt and persona")}
          title="System prompt and persona"
          description="The active instructions, appended rules and the AGENTS.md context that was loaded."
          control={<Button onClick={() => setSystemPromptOpen(true)}>Show system prompt</Button>}
        />
      </SettingsSection>
      {systemPromptOpen ? <SystemPromptModal onClose={() => setSystemPromptOpen(false)} /> : null}

      <SettingsSection title={`Loaded (${ids.length})`} plain>
        {ids.length > 0 ? (
          <table className="inspector-table" aria-label="Loaded extensions">
            <thead><tr><th>Extension</th><th>Desktop</th><th>Host</th><th>Isolation</th><th>Source</th></tr></thead>
            <tbody>
              {ids.map((id) => {
                const desktopHalf = desktop.find((entry) => entry.id === id);
                const hostHalf = hostHalves.find((entry) => entry.id === id);
                const pkg = packages.find((entry) => entry.id === id);
                const commands = hostHalf?.commands.length ? `${hostHalf.commands.length} ${hostHalf.commands.length === 1 ? "command" : "commands"}` : undefined;
                return (
                  <tr key={id} data-extension-id={id}>
                    <td><strong>{desktopHalf?.name ?? hostHalf?.name ?? id}</strong><small>{id}{pkg?.version ? ` · ${pkg.version}` : ""}</small></td>
                    <td><HalfState state={desktopHalf ? (desktopHalf.active ? "active" : "off") : undefined} detail={desktopHalf?.active ? desktopHalf.contributes : undefined} /></td>
                    <td data-host-status={hostHalf?.error ? "failed" : hostHalf?.active ? "active" : "off"}>
                      <HalfState state={hostHalf ? (hostHalf.error ? "failed" : hostHalf.active ? "active" : "off") : undefined} detail={hostHalf?.error ?? (hostHalf?.active ? commands : undefined)} />
                    </td>
                    <td data-isolation={hostHalf?.isolation ?? pkg?.isolation ?? ""}>{hostHalf ? (hostHalf.isolation ?? "in-process") : "—"}</td>
                    <td>{pkg ? <span title={pkg.directory}>{pkg.scope} package</span> : "bundled"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <SettingsState kind="empty" title="No extension is loaded" description="Safe mode starts Tau without extensions. Quit and start it normally to load them." />}
      </SettingsSection>

      {problems.length > 0 ? (
        <SettingsSection title={`Problems (${problems.length})`}>
          {problems.map((problem, index) => (
            <Finding key={`${problem.extensionId}:${index}`} tone={problem.level === "warning" ? "warn" : "danger"} label={problem.level === "warning" ? "Warning" : "Error"} data-extension-id={problem.extensionId}>
              <strong>{problem.extensionName}</strong> · <code>{problem.source}</code>: {problem.message}
            </Finding>
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Not on this client"
        plain
        headerAction={<span className="inspector-profile">
          <Badge>{registry.getProfile()} profile</Badge>
          <HelpTip label="About profiles" text="A contribution names the clients it draws on. What this client leaves out keeps running: the extensions and their host halves stay active." />
        </span>}
      >
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
        ) : <SettingsState kind="empty" title="Every contribution is drawn here" description={`This client, the ${registry.getProfile()} profile, draws everything the active extensions offered.`} />}
      </SettingsSection>

      <SettingsSection title="Packages on disk" id={settingAnchor("Packages on disk")} plain>
        {inspection && inspection.directories.length > 0 ? (
          <ValueList label="Package folders" items={inspection.directories.map((entry) => ({
            label: entry.scope === "global" ? "Global" : "Project", value: entry.directory, mono: true, copy: entry.directory,
          }))} />
        ) : null}
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
        ) : inspection ? <SettingsState kind="empty" title="No package installed" description="No package folder carries a tau-extension.json." /> : null}
        {loadFailures.length + (inspection?.errors.length ?? 0) + (inspection?.skipped.length ?? 0) > 0 ? (
          <div className="settings-group inspector-findings">
            {loadFailures.map((failure) => (
              <Finding key={`load:${failure.path}`} tone="danger" label="Did not build">
                <code>{failure.path}</code>: {failure.message.split("\n")[0]}. The version that was running stays until this builds.
              </Finding>
            ))}
            {inspection?.errors.map((failure) => (
              <Finding key={failure.path} tone="danger" label={failure.incompatible ? "Incompatible" : "Did not load"}><code>{failure.path}</code>: {failure.message}</Finding>
            ))}
            {inspection?.skipped.map((skip) => (
              <Finding key={skip.directory} tone={skip.untrustedProject ? "warn" : "neutral"} label="Skipped">
                <code>{skip.directory}</code>: {skip.reason}
                {skip.packages?.length ? ` It holds ${skip.packages.map((entry) => entry.name).join(", ")}.` : ""}
                {skip.untrustedProject ? " Settings → Packages trusts the project." : ""}
              </Finding>
            ))}
          </div>
        ) : null}
        {error ? <SettingsState kind="error" title="The package folders were not scanned" description={error} onRetry={retry} />
          : !cwd ? <SettingsState kind="empty" title="No project open" description="Open a project to scan its package folder." /> : null}
      </SettingsSection>
    </div>
  );
}
