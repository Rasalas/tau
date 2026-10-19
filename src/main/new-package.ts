import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { globalExtensionsDirectory } from "./extension-packages.js";
import { packagesHome } from "./extension-sources.js";

export interface NewPackageSpec {
  /** Folder name and the end of the id `local.<slug>`: lowercase words joined by dashes. */
  slug: string;
  displayName?: string;
  description?: string;
  /** Adds a host half; the default is the desktop half alone. */
  host?: boolean;
}

export interface NewPackage {
  directory: string;
  id: string;
  name: string;
  apiVersion: string;
  /** Names relative to `directory`; a folder ends in a slash. */
  files: string[];
}

export const PACKAGE_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_SLUG = 40;

interface KitScaffold {
  extensionApiTypes(options: { build: (root: string) => string | undefined }): string | undefined;
  buildCheckoutTypes(root: string): string | undefined;
  kitName(folderName: string, slug: string, name?: string): string;
  writeKit(options: { folder: string; id: string; name: string; description?: string; host: boolean; agents: boolean; types: string }): { files: string[]; apiVersion: string };
}

/** `tau kit new`'s own scaffold, so the command line and the agent tool write the same package. */
export type ScaffoldLoader = () => Promise<KitScaffold>;
const loadScaffold: ScaffoldLoader = () => import(new URL("../../bin/tau-kit.mjs", import.meta.url).href) as Promise<KitScaffold>;

/**
 * Writes a new package into the global extension folder, the one a global
 * install scans, and nowhere else: the folder name is a checked slug and an
 * existing entry is never touched. The package is not installed or approved.
 * `record` notes it as the host's own work, which only this function does.
 */
export async function createNewPackage(spec: NewPackageSpec, options: { home?: string; scaffold?: ScaffoldLoader; types?: string; record?: (made: { id: string; directory: string }) => Promise<void> } = {}): Promise<NewPackage> {
  const slug = spec.slug.trim();
  if (!PACKAGE_SLUG.test(slug) || slug.length > MAX_SLUG) {
    throw new Error(`"${spec.slug}" is not a package name: lowercase letters, digits and single dashes, starting with a letter, at most ${MAX_SLUG} characters (my-button).`);
  }
  const root = globalExtensionsDirectory(options.home ?? packagesHome());
  const directory = join(root, slug);
  if (lstatSync(directory, { throwIfNoEntry: false })) throw new Error(`${directory} already exists; pick another name or edit that package.`);
  const kit = await (options.scaffold ?? loadScaffold)();
  // A checkout builds its types only when no build is there; a release ships them.
  const types = options.types ?? kit.extensionApiTypes({
    build: (checkout) => existsSync(join(checkout, "dist-types", "extension-api", "package.json")) ? undefined : kit.buildCheckoutTypes(checkout),
  });
  if (!types) throw new Error("This Tau cannot find its extension API types to put into the package.");
  const name = kit.kitName(slug, slug, spec.displayName);
  mkdirSync(root, { recursive: true });
  try {
    const written = kit.writeKit({ folder: directory, id: `local.${slug}`, name, ...(spec.description ? { description: spec.description } : {}), host: spec.host === true, agents: true, types });
    await options.record?.({ id: `local.${slug}`, directory });
    return { directory, id: `local.${slug}`, name, apiVersion: written.apiVersion, files: written.files };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
