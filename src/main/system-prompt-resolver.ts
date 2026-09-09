import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DiscoveredPromptFile {
  path: string;
  content: string;
}

export interface DiscoveredPromptOverrides {
  customPrompt?: DiscoveredPromptFile;
  appendPrompts: DiscoveredPromptFile[];
  contextFiles: DiscoveredPromptFile[];
}

function readFileSafely(filePath: string): string | undefined {
  try {
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      return readFileSync(filePath, "utf-8").trim();
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

/**
 * Discovers project and user system-prompt customizations.
 * Checks .tau/ and .pi/ directories in the project workspace and user home directory.
 */
export function discoverPromptOverrides(
  cwd: string,
  agentDir?: string,
  home: string = homedir(),
): DiscoveredPromptOverrides {
  const candidateCustomPrompts = [
    join(cwd, ".tau", "system-prompt.md"),
    join(cwd, ".tau", "SYSTEM.md"),
    join(cwd, ".pi", "system-prompt.md"),
    join(cwd, ".pi", "SYSTEM.md"),
    join(home, ".tau", "system-prompt.md"),
    join(home, ".tau", "SYSTEM.md"),
    ...(agentDir ? [join(agentDir, "SYSTEM.md")] : []),
  ];

  let customPrompt: DiscoveredPromptFile | undefined;
  for (const candidate of candidateCustomPrompts) {
    const content = readFileSafely(candidate);
    if (content !== undefined) {
      customPrompt = { path: candidate, content };
      break;
    }
  }

  const candidateAppendPrompts = [
    join(cwd, ".tau", "append-system-prompt.md"),
    join(cwd, ".tau", "APPEND_SYSTEM.md"),
    join(cwd, ".pi", "append-system-prompt.md"),
    join(cwd, ".pi", "APPEND_SYSTEM.md"),
    join(home, ".tau", "append-system-prompt.md"),
    join(home, ".tau", "APPEND_SYSTEM.md"),
    ...(agentDir ? [join(agentDir, "APPEND_SYSTEM.md")] : []),
  ];

  const appendPrompts: DiscoveredPromptFile[] = [];
  const seenAppendPaths = new Set<string>();
  for (const candidate of candidateAppendPrompts) {
    if (seenAppendPaths.has(candidate)) continue;
    seenAppendPaths.add(candidate);
    const content = readFileSafely(candidate);
    if (content !== undefined) {
      appendPrompts.push({ path: candidate, content });
    }
  }

  const candidateContextFiles = [
    join(cwd, ".tau", "AGENTS.md"),
    join(cwd, ".tau", "instructions.md"),
  ];

  const contextFiles: DiscoveredPromptFile[] = [];
  for (const candidate of candidateContextFiles) {
    const content = readFileSafely(candidate);
    if (content !== undefined) {
      contextFiles.push({ path: candidate, content });
    }
  }

  return {
    customPrompt,
    appendPrompts,
    contextFiles,
  };
}
