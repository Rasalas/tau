import { useCallback, useEffect, useState } from "react";
import type { ExtensionInspection } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";
import { errorMessage } from "../error-message";
import { PACKAGES_EXTENSION_ID } from "../extensions/packages-kit";

/** One row of the host half's `list`, mirrored on this side by shape. */
interface InstalledPackage {
  source: string;
  scope: "global" | "project";
  directory: string;
  id?: string;
  name?: string;
  version?: string;
  signature: { state: "unsigned" | "signed" | "untrusted" | "tampered"; publisher?: string; publisherName?: string; reason?: string };
  error?: string;
}

function signatureLabel(entry: InstalledPackage): string {
  const { signature } = entry;
  if (signature.state === "signed") return `signed by ${signature.publisherName ?? signature.publisher}`;
  if (signature.state === "untrusted") return "signature not trusted";
  if (signature.state === "tampered") return `signature broken: ${signature.reason ?? "the package changed"}`;
  return "unsigned";
}

/**
 * What one package's own settings page says about where it came from, with the
 * installer's verbs when a source in packages.json put it there.
 */
export function PackageProvenance({ id, cwd, onNotify }: { id: string; cwd?: string; onNotify(message: string): void }) {
  const client = useHostClient();
  const [pkg, setPkg] = useState<ExtensionInspection["packages"][number]>();
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    if (!client || !cwd) return;
    client.inspectExtensions(cwd)
      .then((result) => setPkg(result.packages.find((entry) => entry.id === id)))
      .catch(() => undefined);
  }, [client, cwd, id]);
  useEffect(refresh, [refresh]);

  if (!pkg) return null;
  const run = async (command: string, input: unknown) => {
    setBusy(true);
    try {
      const result = await client?.invokeHostExtension(PACKAGES_EXTENSION_ID, command, input) as { message?: string } | undefined;
      onNotify(result?.message ?? "Done.");
      refresh();
    } catch (failure) {
      onNotify(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-label">PACKAGE</div>
      <div className="inspector-folder"><span>version</span><code>{pkg.version ?? "not declared"}</code></div>
      <div className="inspector-folder"><span>signature</span><code>{pkg.signature?.label ?? "unsigned"}</code></div>
      <div className="inspector-folder"><span>isolation</span><code>{pkg.isolation === "in-process" ? "in-process (runs inside the host process)" : "worker"}</code></div>
      <div className="inspector-folder"><span>source</span><code>{pkg.installedFrom ?? pkg.source?.url ?? pkg.directory}</code></div>
      {pkg.installedFrom ? (
        <div className="extension-grant-actions packages-actions">
          <button type="button" disabled={busy} onClick={() => void run("update", { source: pkg.installedFrom })}>Update</button>
          <button type="button" disabled={busy} onClick={() => void run("remove", { source: pkg.installedFrom, scope: pkg.scope })}>Remove</button>
        </div>
      ) : null}
    </>
  );
}

/**
 * Settings page of `tau.packages`: Pi's install verbs with a form. Installing
 * never activates a package — the permission grant on its own page does.
 */
export function PackagesPage({ cwd, onNotify }: { cwd?: string; onNotify(message: string): void }) {
  const client = useHostClient();
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [packages, setPackages] = useState<InstalledPackage[]>();
  const [inspection, setInspection] = useState<ExtensionInspection>();
  const [busy, setBusy] = useState<string>();
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const result = await client.invokeHostExtension(PACKAGES_EXTENSION_ID, "list") as { packages: InstalledPackage[] };
      setPackages(result.packages);
      setError(undefined);
    } catch (failure) {
      setPackages([]);
      setError(errorMessage(failure));
    }
    if (cwd) await client.inspectExtensions(cwd).then(setInspection).catch(() => undefined);
  }, [client, cwd]);

  useEffect(() => { void refresh(); }, [refresh]);

  // The host half reports one line per step of a long command.
  useEffect(() => client?.onHostEvent((event) => {
    if (event.type !== "extension-event" || event.extensionId !== PACKAGES_EXTENSION_ID) return;
    if (event.name === "progress") {
      const message = (event.payload as { message?: string } | undefined)?.message;
      if (message) setLog((lines) => [...lines.slice(-8), message]);
    }
    if (event.name === "changed") void refresh();
  }), [client, refresh]);

  const run = async (label: string, command: string, input: unknown) => {
    if (!client) return;
    setBusy(label);
    setLog([]);
    setError(undefined);
    try {
      const result = await client.invokeHostExtension(PACKAGES_EXTENSION_ID, command, input) as { message?: string };
      onNotify(result.message ?? "Done.");
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(undefined);
    }
  };

  const grantState = (id: string | undefined) => {
    if (!id) return undefined;
    return inspection?.packages.find((entry) => entry.id === id)?.granted;
  };

  return (
    <div className="settings-page">
      <h3>Packages</h3>
      <p className="lede">
        Install extension packages the way Pi does: <code>npm:&lt;package&gt;</code>, <code>git:&lt;url&gt;</code> or a folder on this machine.
        An install never starts a package: approve its permissions on its own page, and both halves start there and then.
      </p>

      <div className="settings-label">INSTALL FROM A SOURCE</div>
      <form
        className="packages-form"
        onSubmit={(event) => { event.preventDefault(); if (source.trim()) void run("install", "install", { source: source.trim(), scope }); }}
      >
        <input
          type="text"
          value={source}
          placeholder="npm:@acme/hello, git:https://example.com/acme/hello.git, or /path/to/folder"
          aria-label="Package source"
          spellCheck={false}
          onChange={(event) => setSource(event.target.value)}
        />
        <button type="submit" className="grant-allow" disabled={!source.trim() || busy !== undefined}>
          {busy === "install" ? "Installing…" : "Install"}
        </button>
      </form>

      <div className="segmented packages-scope">
        <button type="button" className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>Every project</button>
        <button type="button" className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>This project only</button>
      </div>

      {log.length > 0 ? (
        <div className="packages-log" aria-label="Install progress">
          {log.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}
        </div>
      ) : null}

      <div className="settings-label">INSTALLED</div>
      {packages && packages.length > 0 ? (
        <table className="inspector-table" aria-label="Installed packages">
          <thead><tr><th>Package</th><th>Scope</th><th>Signature</th><th>Source</th><th /></tr></thead>
          <tbody>
            {packages.map((entry) => {
              const granted = grantState(entry.id);
              return (
                <tr key={`${entry.scope}:${entry.source}`} data-extension-id={entry.id}>
                  <td>
                    <strong>{entry.name ?? entry.id ?? "unreadable package"}</strong>
                    <small>{entry.id ?? entry.directory}{entry.version ? ` · ${entry.version}` : ""}</small>
                  </td>
                  <td>{entry.scope === "global" ? "every project" : "this project"}</td>
                  <td>{entry.error ?? signatureLabel(entry)}</td>
                  <td><code title={entry.directory}>{entry.source}</code></td>
                  <td className="packages-actions">
                    <button type="button" disabled={busy !== undefined} onClick={() => void run("update", "update", { source: entry.source })}>Update</button>
                    <button type="button" disabled={busy !== undefined} onClick={() => void run("remove", "remove", { source: entry.source, scope: entry.scope })}>Remove</button>
                    {granted === false ? <small>waiting for approval</small> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : packages ? (
        <div className="settings-note">No package source is installed. Packages you copied into the extension folders by hand are listed in the Inspector.</div>
      ) : (
        <div className="settings-note">Reading the package list…</div>
      )}

      <div className="settings-label">UPDATES</div>
      <div className="packages-form">
        <button type="button" className="install-extension" disabled={busy !== undefined || !packages?.length} onClick={() => void run("update", "update", {})}>
          {busy === "update" ? "Updating…" : "Check every source for updates"}
        </button>
      </div>

      {error ? <div className="settings-note" data-level="error">{error}</div> : null}
      <div className="settings-note">
        An npm source installs into <code>~/.tau/npm</code>, a Git source is cloned shallowly into <code>~/.tau/git</code>, and a folder path
        is loaded where it lies. The list of sources is <code>~/.tau/packages.json</code>, or the project's own <code>.tau/packages.json</code>.
        A package may carry a <code>tau-extension.sig</code>; a file that no longer matches its signed hash refuses to load.
      </div>
    </div>
  );
}
