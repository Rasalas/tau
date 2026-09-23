import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import { commandInvocation } from "tau/host-extension";
import {
  IMPORT_PROGRESS_EVENT,
  ONBOARDING_EXTENSION_ID,
  SESSION_SOURCES,
  isSessionSource,
  type Discovery,
  type ImportResult,
  type ImportableSession,
  type ProjectCandidate,
  type ToolId,
  type ToolReport,
  type ToolsReport,
  type WelcomeState,
} from "./protocol.js";

/** Paths per call to a backend kit, so progress moves and the rail fills as it goes. */
const IMPORT_BATCH = 10;
const PROBE_TIMEOUT_MS = 8_000;

type Run = (command: string, args: readonly string[]) => Promise<{ ok: boolean; stdout: string }>;

const run: Run = (command, args) => new Promise((resolve) => {
  // `claude` and `codex` from npm are `.cmd` shims on Windows.
  const invocation = commandInvocation(command, args);
  execFile(invocation.command, invocation.args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }));
});

/** The vendors' own installers and login commands, as T3 Code offers them. */
export function toolCommands(platform: string): Record<ToolId, { command: string; install: string; login: string }> {
  const windows = platform === "win32";
  return {
    "claude-code": { command: "claude", install: windows ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash", login: "claude auth login" },
    codex: { command: "codex", install: windows ? "irm https://chatgpt.com/codex/install.ps1 | iex" : "curl -fsSL https://chatgpt.com/codex/install.sh | sh", login: "codex login" },
    gh: { command: "gh", install: windows ? "winget install --id GitHub.cli" : platform === "darwin" ? "brew install gh" : "sudo apt install gh", login: "gh auth login" },
    glab: { command: "glab", install: windows ? "winget install --id GLab.GLab" : "brew install glab", login: "glab auth login" },
  };
}

/** Bad input: it reaches the caller like any error and never counts against the kit. */
function refused(message: string): Error {
  return Object.assign(new Error(message), { expected: true });
}

function version(stdout: string): string | undefined {
  return /\d+\.\d+\.\d+[^\s)]*/u.exec(stdout)?.[0];
}

interface BackendScan { sessions?: unknown; truncated?: unknown }

function sessionsOf(source: ImportableSession["source"], answer: BackendScan): ImportableSession[] {
  if (!Array.isArray(answer.sessions)) return [];
  return answer.sessions.flatMap((value): ImportableSession[] => {
    const item = value as Partial<ImportableSession> | null;
    if (!item || typeof item.path !== "string" || typeof item.sessionId !== "string" || typeof item.cwd !== "string" || typeof item.updatedAt !== "number") return [];
    return [{ source, path: item.path, sessionId: item.sessionId, cwd: item.cwd, title: typeof item.title === "string" ? item.title : "", updatedAt: item.updatedAt, imported: item.imported === true }];
  });
}

async function folder(path: string): Promise<{ exists: boolean; git: boolean }> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) return { exists: false, git: false };
  return { exists: true, git: Boolean(await stat(join(path, ".git")).catch(() => undefined)) };
}

/** Folders newest first; one that no longer exists is not offered. */
export async function projectCandidates(sessions: readonly ImportableSession[], piThreads: ReadonlyArray<{ cwd: string; updatedAt?: number }>): Promise<ProjectCandidate[]> {
  const byPath = new Map<string, ProjectCandidate>();
  const add = (path: string, source: ProjectCandidate["sources"][number], at: number) => {
    const entry = byPath.get(path) ?? { path, name: basename(path) || path, sources: [], threadCount: 0, lastActiveAt: 0, git: false };
    if (!entry.sources.includes(source)) entry.sources.push(source);
    entry.threadCount += 1;
    entry.lastActiveAt = Math.max(entry.lastActiveAt, at);
    byPath.set(path, entry);
  };
  for (const session of sessions) add(session.cwd, session.source, session.updatedAt);
  for (const thread of piThreads) add(thread.cwd, "pi", thread.updatedAt ?? 0);
  const candidates = await Promise.all([...byPath.values()].map(async (entry) => {
    const found = await folder(entry.path);
    return found.exists ? [{ ...entry, git: found.git }] : [];
  }));
  return candidates.flat().sort((left, right) => right.lastActiveAt - left.lastActiveAt);
}

export interface OnboardingHostOptions {
  platform?: string;
  run?: Run;
}

/**
 * The host half of `tau.onboarding`. It runs in a worker: it asks the
 * machine which CLIs are there, asks the backend kits which conversations
 * their CLIs keep, and hands their import on. It reads no session file itself.
 */
export function createOnboardingHostExtension(options: OnboardingHostOptions = {}): WorkerHostExtension & { permissions: string[] } {
  const platform = options.platform ?? process.platform;
  const exec = options.run ?? run;
  return {
    id: ONBOARDING_EXTENSION_ID,
    name: "Onboarding",
    permissions: ["process", "sessions"],
    activate(context: WorkerHostExtensionContext) {
      const services = context.services;
      const stateFile = join(services.stateDir, "welcome.json");
      const completed = () => readFile(stateFile, "utf8").then((text) => Boolean((JSON.parse(text) as { completedAt?: unknown }).completedAt), () => false);

      context.registerCommand("state", async (): Promise<WelcomeState> => {
        const done = await completed();
        return { completed: done, firstStart: !done && (await services.sessions.list()).length === 0 };
      });
      context.registerCommand("complete", async () => {
        await mkdir(services.stateDir, { recursive: true });
        await writeFile(stateFile, `${JSON.stringify({ completedAt: new Date().toISOString() })}\n`);
      });

      // gh and glab are asked here; the agent CLIs answer through their own kits, which know their path overrides.
      context.registerCommand("tools", async (): Promise<ToolsReport> => {
        const commands = toolCommands(platform);
        const tools = await Promise.all((Object.keys(commands) as ToolId[]).map(async (id): Promise<ToolReport> => {
          const { command, install, login } = commands[id];
          const path = await services.findCommand(command);
          const report: ToolReport = { id, install, login, ...(path ? { path } : {}) };
          if (!path || (id !== "gh" && id !== "glab")) return report;
          await services.noteSubprocess();
          const [versionRun, auth] = await Promise.all([exec(path, ["--version"]), exec(path, ["auth", "status"])]);
          const found = version(versionRun.stdout);
          return { ...report, ...(found ? { version: found } : {}), signedIn: auth.ok };
        }));
        return { platform, tools };
      });

      context.registerCommand("discover", async (): Promise<Discovery> => {
        const unavailable: Discovery["unavailable"] = [];
        let truncated = false;
        const scans = await Promise.all(SESSION_SOURCES.map(async ({ source, extensionId }) => {
          try {
            const answer = await context.invokeHostExtension(extensionId, "import-scan") as BackendScan;
            if (answer?.truncated === true) truncated = true;
            return sessionsOf(source, answer ?? {});
          } catch (error) {
            unavailable.push({ source, reason: error instanceof Error ? error.message : String(error) });
            return [];
          }
        }));
        const sessions = scans.flat().sort((left, right) => right.updatedAt - left.updatedAt);
        const pi = await services.sessions.list().catch(() => []);
        // Pi's threads are Tau's already; they only suggest folders.
        return { projects: await projectCandidates(sessions, pi), sessions, truncated, unavailable };
      }, { long: true });

      // The identity a client opens a found folder under; the host admits it here.
      context.registerCommand("project-ref", async (input) => {
        const path = (input as { path?: unknown } | undefined)?.path;
        if (typeof path !== "string" || !isAbsolute(path) || !(await folder(path)).exists) throw refused("That folder does not exist.");
        return services.workspaceRef(path);
      });

      context.registerCommand("import-sessions", async (input): Promise<ImportResult> => {
        const { source, paths } = (input ?? {}) as { source?: unknown; paths?: unknown };
        const target = SESSION_SOURCES.find((entry) => isSessionSource(source) && entry.source === source);
        if (!target || !Array.isArray(paths)) throw refused("import-sessions needs a source and paths.");
        const result: ImportResult = { imported: 0, skipped: 0, failed: 0 };
        for (let done = 0; done < paths.length; done += IMPORT_BATCH) {
          const batch = paths.slice(done, done + IMPORT_BATCH);
          const answer = await context.invokeHostExtension(target.extensionId, "import-sessions", { paths: batch }) as { imported?: unknown[]; skipped?: number; failed?: unknown[]; update?: unknown };
          result.imported += answer.imported?.length ?? 0;
          result.skipped += answer.skipped ?? 0;
          result.failed += answer.failed?.length ?? 0;
          if (answer.update) result.update = answer.update;
          context.emit(IMPORT_PROGRESS_EVENT, { source: target.source, done: Math.min(done + batch.length, paths.length), total: paths.length });
        }
        return result;
      }, { long: true });
    },
  };
}

export default createOnboardingHostExtension;
