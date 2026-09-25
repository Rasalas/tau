/**
 * What a host says about the machine it runs on, asked for and never pushed
 * (`host-resources` and `readiness`, API 1.15.0): how busy it is, and whether
 * it could take on a thread. Another machine's host asks through
 * `services.machines.request`, Settings → Machines draws both.
 */

export interface HostResources {
  /** Epoch ms of the reading on the host's clock; compare with the time it arrived, not with another clock. */
  sampledAt: number;
  cpuCount: number;
  /** 0–1 across all cores over the last few seconds; absent when the counters did not move. */
  cpuUtilization?: number;
  totalMemory: number;
  /** Bytes the system can hand out without swapping: free plus reclaimable cache. */
  availableMemory: number;
  /** Threads of this host running a turn now. */
  runningTurns: number;
  /** Absent on a machine without a battery or where the host cannot tell. */
  onBattery?: boolean;
}

/** `ready`: can run a thread. `checking`: the runtime has not answered since the host started. */
export type RuntimeReadinessState = "ready" | "sign-in-required" | "not-installed" | "unavailable" | "checking";

export interface RuntimeReadiness {
  /** The backend kind: `pi`, `codex`, `codex@work`. */
  kind: string;
  label: string;
  state: RuntimeReadinessState;
  /** The program's version, when the host asked it. */
  version?: string;
  /** Models a new thread may pick; absent where the runtime names them only once a thread runs. */
  models?: number;
  /** Why it is not ready, in the runtime's words. */
  note?: string;
}

/** `screen`: a desktop session. `invisible`: Xvfb. `none`: nothing a GUI program could open a window on. */
export type HostDisplayKind = "screen" | "x11" | "wayland" | "invisible" | "none";

export interface HostReadiness {
  checkedAt: number;
  runtimes: RuntimeReadiness[];
  /** `version` absent: no git on the host's PATH. */
  git: { version?: string; mergeTree: boolean };
  /** Free space where new worktrees go; `error` when the folder could not be looked at. */
  disk: { path: string; free?: number; total?: number; error?: string };
  display: { kind: HostDisplayKind; name?: string };
}

/** `git merge-tree --write-tree`, which checks a merge without a checkout, came with Git 2.38. */
export const MERGE_TREE_GIT = [2, 38] as const;

/** "git version 2.39.5 (Apple Git-154)" → "2.39.5". */
export function parseGitVersion(output: string): string | undefined {
  return /git version (\d+\.\d+(?:\.\d+)?)/u.exec(output)?.[1];
}

export function gitHasMergeTree(version: string | undefined): boolean {
  if (!version) return false;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MERGE_TREE_GIT[0] || (major === MERGE_TREE_GIT[0] && minor >= MERGE_TREE_GIT[1]);
}
