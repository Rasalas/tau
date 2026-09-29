import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { BuildDiagnostic, PackageBuild } from "../shared/contracts.js";
import { formatBuildDiagnostics } from "../shared/build-diagnostics.js";

interface EsbuildMessage {
  text?: unknown;
  location?: { file?: unknown; line?: unknown; column?: unknown; lineText?: unknown } | null;
}

/**
 * esbuild's errors as diagnostics, files relative to the package folder.
 * esbuild names files relative to the process's working directory, which says
 * nothing to the author; undefined for an error that is not esbuild's.
 */
export function buildDiagnostics(error: unknown, directory?: string): BuildDiagnostic[] | undefined {
  const messages = (error as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  return (messages as EsbuildMessage[]).map((message) => {
    const location = message.location ?? undefined;
    const file = typeof location?.file === "string" && location.file ? displayPath(location.file, directory) : undefined;
    return {
      ...(file ? { file } : {}),
      ...(typeof location?.line === "number" ? { line: location.line } : {}),
      ...(typeof location?.column === "number" ? { column: location.column } : {}),
      text: typeof message.text === "string" ? message.text : String(message.text),
      ...(typeof location?.lineText === "string" ? { lineText: location.lineText } : {}),
    };
  });
}

function displayPath(file: string, directory: string | undefined): string {
  const absolute = isAbsolute(file) ? file : resolve(file);
  if (!directory) return absolute;
  // esbuild reports real paths: /private/var for /var on macOS.
  for (const root of new Set([directory, realOrSame(directory)])) {
    const inside = relative(root, absolute);
    if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return inside;
  }
  return absolute;
}

function realOrSame(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** A failed build as a load error: every diagnostic in the message, and the diagnostics beside it. */
export function describeBuildError(error: unknown, directory?: string): { message: string; diagnostics?: BuildDiagnostic[] } {
  const diagnostics = buildDiagnostics(error, directory);
  if (!diagnostics) return { message: error instanceof Error ? error.message : String(error) };
  return { message: formatBuildDiagnostics(diagnostics), diagnostics };
}

/**
 * The last build of each package half this host compiled, for the author
 * looking at why a save did not take. One entry per half and entry file; a
 * new build replaces the old one.
 */
export class PackageBuildJournal {
  private readonly builds = new Map<string, PackageBuild>();
  private readonly listeners = new Set<(build: PackageBuild) => void>();

  record(build: PackageBuild): void {
    this.builds.set(`${build.half}:${build.entry}`, build);
    for (const listener of [...this.listeners]) {
      try { listener(build); } catch { /* A listener's failure is its own. */ }
    }
  }

  list(): PackageBuild[] {
    return [...this.builds.values()].sort((left, right) => right.at - left.at);
  }

  observe(listener: (build: PackageBuild) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** The host process's journal: desktop and host halves are both compiled there. */
export const packageBuilds = new PackageBuildJournal();
