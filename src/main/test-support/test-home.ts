import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the user's own tools keep their state under the real home; no test writes there. */
const GUARDED = [".pi", ".tau", ".codex", ".claude", ".claude.json", ".gemini", ".cursor", ".grok", ".config", ".local", ".zshrc", "Library"];

/** Variables that move a tool's state away from HOME. Unset, each one falls back to the test's home. */
const HOME_VARIABLES = [
  "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_HOME", "GROK_HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "ZDOTDIR",
  "TAU_USER_DATA", "TAU_CONFIG_FILE", "TAU_WORKTREES_DIR", "TAU_HOST_TOKEN_FILE", "TAU_THEMES_DIR", "TAU_SERVICE_UNIT_DIR",
  "TAU_OPENCODE_HOME", "TAU_CURSOR_HOME", "TAU_GROK_HOME",
  // The developer's own ssh-agent, and an instance's servers fakes, never reach a test.
  "SSH_AUTH_SOCK", "SSH_AGENT_PID", "FAKE_SERVERS_STATE",
  "TAU_SERVERS_SECURITY_COMMAND", "TAU_SERVERS_SECRET_TOOL_COMMAND", "TAU_SERVERS_SSH_CONFIG",
];

/** fs functions that change the file system, with the positions of the paths they change. */
const WRITERS: Record<string, number[]> = {
  writeFile: [0], appendFile: [0], mkdir: [0], mkdtemp: [0], rm: [0], rmdir: [0], unlink: [0], rename: [0, 1],
  copyFile: [1], cp: [1], symlink: [1], link: [1], truncate: [0], chmod: [0], utimes: [0], createWriteStream: [0],
};

export interface TestHome {
  home: string;
  /** Writes a test tried under the real home; each one was refused. */
  violations: string[];
  remove(): void;
}

let current: TestHome | undefined;

/** The home src/test-setup.ts gave this file. */
export function currentTestHome(): TestHome | undefined {
  return current;
}

/**
 * Gives this test file a home of its own, and refuses any write into the real
 * one's tool folders. Subprocesses inherit the home; the refusal covers this process.
 */
export function isolateHome(): TestHome {
  const realHome = userInfo().homedir;
  const home = fs.mkdtempSync(join(tmpdir(), "tau-test-home-"));
  process.env.HOME = home;
  if (process.platform === "win32") {
    process.env.USERPROFILE = home;
    process.env.APPDATA = join(home, "AppData", "Roaming");
    process.env.LOCALAPPDATA = join(home, "AppData", "Local");
  }
  for (const name of HOME_VARIABLES) delete process.env[name];

  const guarded = GUARDED.map((entry) => join(realHome, entry));
  const violations: string[] = [];
  const check = (name: string, target: unknown) => {
    const path = typeof target === "string" ? target : target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : undefined;
    if (path === undefined) return;
    const absolute = resolve(path);
    if (!guarded.some((root) => absolute === root || absolute.startsWith(root + sep))) return;
    violations.push(`${name} ${absolute}`);
    throw Object.assign(new Error(`A test tried to change ${absolute}, in the real home; tests get a home of their own.`), { code: "EACCES" });
  };
  const opensForWriting = (flags: unknown) => typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 : typeof flags === "string" && /[wa+]/u.test(flags);

  // A promise function rejects, as a refused write would; the others throw.
  const guard = (target: Record<string, unknown>, name: string, refuse: (args: unknown[]) => void, promised: boolean) => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function refusing(this: unknown, ...args: unknown[]) {
      try {
        refuse(args);
      } catch (error) {
        if (promised) return Promise.reject(error);
        throw error;
      }
      return (original as (...values: unknown[]) => unknown).apply(this, args);
    };
  };
  const fsObject = fs as unknown as Record<string, unknown>;
  const promises = fs.promises as unknown as Record<string, unknown>;
  for (const [name, positions] of Object.entries(WRITERS)) {
    const refuse = (args: unknown[]) => { for (const position of positions) check(name, args[position]); };
    guard(fsObject, name, refuse, false);
    guard(fsObject, `${name}Sync`, refuse, false);
    guard(promises, name, refuse, true);
  }
  const refuseOpen = (args: unknown[]) => { if (opensForWriting(args[1])) check("open", args[0]); };
  guard(fsObject, "open", refuseOpen, false);
  guard(fsObject, "openSync", refuseOpen, false);
  guard(promises, "open", refuseOpen, true);
  // Named imports of node:fs and node:fs/promises read these bindings.
  syncBuiltinESMExports();

  current = {
    home,
    violations,
    remove: () => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }),
  };
  return current;
}
