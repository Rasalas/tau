import { Hammer } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, SettingRow, SettingsSection, SettingsState, errorMessage, type HostExtensionClient, type PackageBuild } from "tau";

/** One package's last builds, desktop half first. */
export interface PackageBuilds {
  directory: string;
  id?: string;
  halves: PackageBuild[];
}

/** The journal grouped by package folder, the package with the newest build first. */
export function groupBuilds(builds: readonly PackageBuild[]): PackageBuilds[] {
  const groups = new Map<string, PackageBuilds>();
  for (const build of [...builds].sort((left, right) => right.at - left.at)) {
    const group = groups.get(build.directory) ?? { directory: build.directory, ...(build.id ? { id: build.id } : {}), halves: [] };
    group.halves.push(build);
    groups.set(build.directory, group);
  }
  for (const group of groups.values()) group.halves.sort((left, right) => left.half.localeCompare(right.half));
  return [...groups.values()];
}

/** A newer build of the same half and entry replaces the one the view holds. */
export function mergeBuild(builds: readonly PackageBuild[], build: PackageBuild): PackageBuild[] {
  return [build, ...builds.filter((entry) => entry.half !== build.half || entry.entry !== build.entry)];
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * Settings → Packages → Develop a package: how to start one, and the last
 * build of each installed package's halves with esbuild's errors in full,
 * updated as the host rebuilds a saved file.
 */
export function DevelopSection({ host, nameOf, onNotify }: {
  host: HostExtensionClient;
  /** The package's name, where the page knows it. */
  nameOf(id: string | undefined): string | undefined;
  onNotify(message: string): void;
}) {
  const [builds, setBuilds] = useState<PackageBuild[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setBuilds((await host.invoke("builds") as { builds: PackageBuild[] }).builds);
      setError(undefined);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [host]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => host.onEvent("build", (payload) => {
    setBuilds((current) => mergeBuild(current ?? [], payload as PackageBuild));
  }), [host]);

  const rebuild = async () => {
    setBusy(true);
    try {
      onNotify((await host.invoke("rebuild") as { message?: string }).message ?? "Rebuilt.");
      await load();
    } catch (reason) {
      onNotify(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const groups = groupBuilds(builds ?? []);
  return (
    <SettingsSection
      title="Develop a package"
      headerAction={<Button variant="ghost" icon={<Hammer size={13} />} busy={busy} onClick={() => void rebuild()}>{busy ? "Rebuilding…" : "Rebuild"}</Button>}
    >
      <SettingRow
        id="setting-packages-develop"
        title="Start a package"
        description={<>Run <code>tau kit new my-kit</code> in a terminal: it writes a folder with a manifest, both halves, types for your editor and a README. Install the folder above; each save rebuilds it and the result shows here.</>}
      />
      {error ? <SettingsState kind="error" title="The builds did not load" description={error} onRetry={() => void load()} />
        : builds === undefined ? <SettingsState kind="loading" title="Reading the last builds" rows={1} />
          : groups.length === 0 ? <SettingsState kind="empty" title="No package built yet" description="A package you install is built when it loads; its last build shows here." />
            : groups.map((group) => {
              const failed = group.halves.filter((build) => !build.ok);
              return (
                <SettingRow
                  key={group.directory}
                  title={<>{nameOf(group.id) ?? group.id ?? group.directory.split(/[\\/]/u).pop()}{failed.length > 0 ? <> <Badge tone="danger">Did not build</Badge></> : <> <Badge tone="success">Built</Badge></>}</>}
                  description={<code>{group.directory}</code>}
                  status={group.halves.map((build) => `${build.half === "desktop" ? "Desktop" : "Host"} half ${build.ok ? "built" : "failed"} at ${time(build.at)}`).join(" · ")}
                >
                  {failed.map((build) => (
                    <pre key={`${build.half}:${build.entry}`} className="packages-build-error" aria-label={`${build.half} build error`}>{build.message}</pre>
                  ))}
                </SettingRow>
              );
            })}
    </SettingsSection>
  );
}
