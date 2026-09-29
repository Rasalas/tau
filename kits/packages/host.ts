import { HostCommandError, type HostExtension, type HostExtensionContext, type InstalledPackage, type PackageScope } from "tau/host-extension";
import { isAbsolute } from "node:path";
import { PACKAGES_EXTENSION_ID, type PackageRow } from "./protocol.js";

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? input as Record<string, unknown> : {};

function requiredSource(input: unknown): string {
  const value = record(input).source;
  if (typeof value !== "string" || !value.trim()) throw new HostCommandError("Name a source: npm:<package>, git:<url> or a folder path.");
  return value.trim();
}

function optionalSource(input: unknown): string | undefined {
  const value = record(input).source;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function scopeOf(input: unknown): PackageScope {
  const value = record(input).scope;
  if (value === undefined || value === "global") return "global";
  if (value === "project") return "project";
  throw new HostCommandError(`"scope" is "global" or "project", not "${String(value)}"`);
}

/** The installer's facts, without the signature vocabulary the desktop half does not need. */
export function row(entry: InstalledPackage): PackageRow {
  return {
    source: entry.source,
    scope: entry.scope,
    directory: entry.directory,
    ...(entry.id ? { id: entry.id } : {}),
    ...(entry.name ? { name: entry.name } : {}),
    ...(entry.version ? { version: entry.version } : {}),
    signatureLabel: entry.signatureLabel,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

/** One line per package, close to what `pi list` prints. */
export function describeInstalled(entry: PackageRow): string {
  const head = entry.id ? `${entry.id}${entry.version ? ` ${entry.version}` : ""}` : entry.source;
  return `${head} · ${entry.scope} · ${entry.error ?? entry.signatureLabel}`;
}

/**
 * Tau's package manager, shaped like Pi's: `install`, `remove`, `update` and
 * `list` over `npm:`, `git:` and path sources. The host owns the installer
 * itself (the `packages` permission); this kit owns the verbs, the wording and
 * when the workspace has to rescan. Installing never activates a package; the
 * permission grant still decides that.
 *
 * It manages packages while being one. That works because a kit is loaded
 * before any installed package and never re-imported by a rescan: the activator
 * only ever touches what it scanned from the package folders, and it refuses a
 * package that claims a kit's id.
 */
export function createPackagesHostExtension(): HostExtension {
  return {
    id: PACKAGES_EXTENSION_ID,
    name: "Packages",
    permissions: ["packages"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      const announce = (name: string, payload: unknown) => {
        context.emit("changed", { command: name, result: payload });
      };
      // The scan is what turns a folder on disk into running halves, so an
      // installed, updated or removed package takes effect without a reload.
      const rescan = async () => {
        try {
          await services.refreshExtensionPackages();
        } catch (error) {
          services.log("packages.rescan.failed", error instanceof Error ? error.message : String(error));
        }
      };
      // One line per step of a long command, for whatever settings page is watching.
      const step = (message: string) => {
        services.log("packages.progress", message);
        context.emit("progress", { message });
      };

      context.registerCommand("list", async () => ({ packages: (await services.listPackages()).map(row) }), { access: "read" });

      context.registerCommand("install", async (input) => {
        const source = requiredSource(input);
        const scope = scopeOf(input);
        services.log("packages.install", `${source} (${scope})`);
        const installed = row(await services.installPackage(source, scope, step));
        await rescan();
        announce("install", installed);
        // A project install in a project Pi does not trust is skipped by every scan until it is trusted.
        if (scope === "project" && services.projectTrust && !services.projectTrust.trusted()) {
          return { installed, untrusted: true, message: `${describeInstalled(installed)} — skipped: Pi does not trust this project. Trust it in Settings → Packages, then approve the package in Settings → Extensions.` };
        }
        return { installed, message: `${describeInstalled(installed)} — approve it in Settings → Extensions to start it.` };
      }, { long: true });

      // The last build of each package half, and each new one as it lands: Settings → Packages' development view.
      context.registerCommand("builds", () => ({ builds: services.packageBuilds?.list() ?? [] }), { access: "read" });
      const stopBuilds = services.packageBuilds?.observe((build) => context.emit("build", build));

      context.registerCommand("rebuild", async () => {
        await rescan();
        return { message: "Rebuilt the installed packages; a half whose code did not change kept running." };
      });

      context.registerCommand("trust", async (input) => {
        const trust = services.projectTrust;
        if (!trust) throw new HostCommandError("This host cannot record Pi's project trust.");
        const value = record(input).cwd;
        if (value !== undefined && (typeof value !== "string" || !isAbsolute(value))) throw new HostCommandError(`"cwd" must be an absolute path.`);
        const cwd = trust.trust(value);
        services.log("packages.trust", cwd);
        await rescan();
        announce("trust", { cwd });
        return { cwd, message: `Pi trusts ${cwd} now; its packages load. Approve new ones in Settings → Extensions.` };
      });

      context.registerCommand("remove", async (input) => {
        const source = requiredSource(input);
        const scope = scopeOf(input);
        const result = await services.removePackage(source, scope);
        if (!result.removed) throw new HostCommandError(`${source} is not listed in the ${scope} packages.json.`);
        services.log("packages.remove", `${source} (${scope})`);
        await rescan();
        announce("remove", result);
        return { ...result, message: `Removed ${source}.` };
      });

      context.registerCommand("update", async (input) => {
        const updated = (await services.updatePackages(optionalSource(input), step)).map(row);
        await rescan();
        announce("update", updated);
        const failed = updated.filter((entry) => entry.error);
        return {
          packages: updated,
          message: updated.length === 0
            ? "No package source is installed."
            : `${updated.length - failed.length} of ${updated.length} updated and re-activated.`,
        };
      }, { long: true });
      return () => { stopBuilds?.(); };
    },
  };
}

export default createPackagesHostExtension;
