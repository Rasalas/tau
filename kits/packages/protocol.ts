/**
 * What the Packages kit's two halves agree on. Core knows nothing about install
 * verbs; it only scans the folders a source resolved to and applies grants.
 */
export const PACKAGES_EXTENSION_ID = "tau.packages";

/** Settings page the kit contributes; `app.openSettings(PACKAGES_SETTINGS_PAGE)` opens it. */
export const PACKAGES_SETTINGS_PAGE = "packages";

/** One row of `list`, `install` and `update`: a source and the package it resolved to. */
export interface PackageRow {
  source: string;
  scope: "global" | "project";
  directory: string;
  id?: string;
  name?: string;
  version?: string;
  /** What the package's optional signature proved, in one line. */
  signatureLabel: string;
  /** Why the package could not be read, if it could not. */
  error?: string;
}

export interface PackagesHostCommands {
  "list": { input: undefined; output: { packages: PackageRow[] } };
  "install": { input: { source: string; scope?: "global" | "project" }; output: { installed: PackageRow; message: string } };
  "remove": { input: { source: string; scope?: "global" | "project" }; output: { removed: boolean; deleted: boolean; message: string } };
  "update": { input: { source?: string }; output: { packages: PackageRow[]; message: string } };
}

/** `<source> [--local]`, the flag Pi spells `-l`. */
export function parseInstallArguments(args: string): { source: string; scope: "global" | "project" } {
  const words = args.trim().split(/\s+/u).filter(Boolean);
  const local = words.some((word) => word === "-l" || word === "--local" || word === "--project");
  const source = words.filter((word) => !word.startsWith("-")).join(" ");
  return { source, scope: local ? "project" : "global" };
}
