/**
 * What the Packages kit's two halves agree on. Core knows nothing about install
 * verbs; it only scans the folders a source resolved to and applies grants.
 */
export const PACKAGES_EXTENSION_ID = "tau.packages";

/** The Settings page the kit had before its sections joined Extensions (API 1.61.0); a link to it lands there. */
export const PACKAGES_RETIRED_PAGE = "packages";

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

/** `<source> [--local]`, the flag Pi spells `-l`. */
export function parseInstallArguments(args: string): { source: string; scope: "global" | "project" } {
  const words = args.trim().split(/\s+/u).filter(Boolean);
  const local = words.some((word) => word === "-l" || word === "--local" || word === "--project");
  const source = words.filter((word) => !word.startsWith("-")).join(" ");
  return { source, scope: local ? "project" : "global" };
}

/** The project whose folder is the global extension folder, where a request to change Tau becomes a package. */
export const CUSTOMIZATION_PROJECT_NAME = "Tau customizations";

/** What a new thread in that project starts with: editable, never sent by itself. */
export const CUSTOMIZE_PROMPT_PREFIX = "Change Tau: ";

/** The host's answer to `customization-project`: the folder and how clients name it as a project. */
export interface CustomizationProject {
  directory: string;
  workspaceId: string;
}

/** The host's answer to `customization-folder`: where the project lies (or will) and how many packages are in it. */
export interface CustomizationFolder {
  directory: string;
  packages: number;
}
