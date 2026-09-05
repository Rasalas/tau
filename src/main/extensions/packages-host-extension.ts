import { homedir } from "node:os";
import type { HostExtension, HostExtensionContext } from "../host-extensions.js";
import {
  installExtensionSource,
  listExtensionSources,
  removeExtensionSource,
  updateExtensionSources,
  type InstalledExtension,
  type InstallerOptions,
} from "../extension-installer.js";
import type { PackageScope } from "../extension-sources.js";
import { describeSignature } from "../extension-signature.js";

export const PACKAGES_HOST_EXTENSION_ID = "tau.packages";

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? input as Record<string, unknown> : {};

function requiredSource(input: unknown): string {
  const value = record(input).source;
  if (typeof value !== "string" || !value.trim()) throw new Error("Name a source: npm:<package>, git:<url> or a folder path.");
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
  throw new Error(`"scope" is "global" or "project", not "${String(value)}"`);
}

/** One line per package, close to what `pi list` prints. */
export function describeInstalled(entry: InstalledExtension): string {
  const head = entry.id ? `${entry.id}${entry.version ? ` ${entry.version}` : ""}` : entry.source;
  return `${head} · ${entry.scope} · ${entry.error ?? describeSignature(entry.signature)}`;
}

/**
 * Tau's package manager, shaped like Pi's: `install`, `remove`, `update` and
 * `list` over `npm:`, `git:` and path sources. Installing never activates a
 * package; the permission grant still decides that.
 */
export function createPackagesHostExtension(options: { home?: string } = {}): HostExtension {
  return {
    id: PACKAGES_HOST_EXTENSION_ID,
    name: "Packages",
    permissions: ["workspace:read", "process"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      const installer = (progress?: (message: string) => void): InstallerOptions => ({
        cwd: services.cwd(),
        home: options.home ?? homedir(),
        findCommand: (name) => services.findCommand(name),
        ...(progress ? { progress } : {}),
      });
      const announce = (name: string, payload: unknown) => {
        context.emit("changed", { command: name, result: payload });
      };
      // One line per step of a long command, for whatever settings page is watching.
      const step = (message: string) => {
        services.log("packages.progress", message);
        context.emit("progress", { message });
      };

      context.registerCommand("list", async () => ({ packages: await listExtensionSources(installer()) }));

      context.registerCommand("install", async (input) => {
        const source = requiredSource(input);
        const scope = scopeOf(input);
        services.noteSubprocess();
        services.log("packages.install", `${source} (${scope})`);
        const installed = await installExtensionSource(source, scope, installer(step));
        announce("install", installed);
        return { installed, message: `${describeInstalled(installed)} — approve it in Settings, then run /reload.` };
      }, { long: true });

      context.registerCommand("remove", async (input) => {
        const source = requiredSource(input);
        const scope = scopeOf(input);
        const result = await removeExtensionSource(source, scope, installer());
        if (!result.removed) throw new Error(`${source} is not listed in the ${scope} packages.json.`);
        services.log("packages.remove", `${source} (${scope})`);
        announce("remove", result);
        return { ...result, message: `Removed ${source}. Run /reload to drop it from this session.` };
      });

      context.registerCommand("update", async (input) => {
        services.noteSubprocess();
        const updated = await updateExtensionSources(optionalSource(input), installer(step));
        announce("update", updated);
        const failed = updated.filter((entry) => entry.error);
        return {
          packages: updated,
          message: updated.length === 0
            ? "No package source is installed."
            : `${updated.length - failed.length} of ${updated.length} updated. Run /reload to apply.`,
        };
      }, { long: true });
    },
  };
}
