import { readFileSync } from "node:fs";

/** Zombies no longer run tools, even while a container's init has not reaped them. */
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return true;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch { return false; }
}
