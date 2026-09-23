import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/** Set in every test worker; each process a test starts inherits it, detached or not. */
export const TEST_RUN_VARIABLE = "TAU_TEST_RUN";
/** The test file that was running when the process started, URI-encoded. */
export const TEST_FILE_VARIABLE = "TAU_TEST_FILE";

export interface RunProcess {
  pid: number;
  command: string;
  file?: string;
}

/**
 * The live processes whose environment carries this run's tag. Nothing else
 * matches: another run, in this checkout or another, has its own tag.
 */
export function findRunProcesses(run: string): RunProcess[] {
  if (process.platform === "linux") return fromProc(run);
  if (process.platform === "darwin") return fromPs(run);
  return [];
}

function fromProc(run: string): RunProcess[] {
  const found: RunProcess[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const environment = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
      if (!environment.includes(`${TEST_RUN_VARIABLE}=${run}`)) continue;
      const command = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      const file = environment.find((entry) => entry.startsWith(`${TEST_FILE_VARIABLE}=`))?.slice(TEST_FILE_VARIABLE.length + 1);
      found.push({ pid: Number(name), command, ...(file ? { file: decodeURIComponent(file) } : {}) });
    } catch {
      // Gone meanwhile, a zombie, or somebody else's process.
    }
  }
  return found;
}

function fromPs(run: string): RunProcess[] {
  // `ps` would carry the tag itself when a test calls this.
  const env = { ...process.env };
  delete env[TEST_RUN_VARIABLE];
  delete env[TEST_FILE_VARIABLE];
  // `e` appends each process's environment to its command line.
  const withEnvironment = execFileSync("ps", ["axeww", "-o", "pid=,command="], { encoding: "utf8", env, maxBuffer: 64 * 1024 * 1024 });
  const tag = ` ${TEST_RUN_VARIABLE}=${run}`;
  const files = new Map<number, string | undefined>();
  for (const line of withEnvironment.split("\n")) {
    if (!line.includes(`${tag} `) && !line.endsWith(tag)) continue;
    const pid = Number.parseInt(line.trim(), 10);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    files.set(pid, new RegExp(` ${TEST_FILE_VARIABLE}=(\\S+)`, "u").exec(line)?.[1]);
  }
  if (files.size === 0) return [];
  let commands = "";
  try {
    commands = execFileSync("ps", ["-ww", "-o", "pid=,command=", "-p", [...files.keys()].join(",")], { encoding: "utf8", env });
  } catch (error) {
    // `ps -p` exits 1 when none of them is alive any more.
    commands = String((error as { stdout?: unknown }).stdout ?? "");
  }
  const found: RunProcess[] = [];
  for (const line of commands.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const file = files.get(pid);
    found.push({ pid, command: match[2]!, ...(file ? { file: decodeURIComponent(file) } : {}) });
  }
  return found;
}
