import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";

function sysctl(name) {
  return execFileSync("sysctl", ["-n", name], { encoding: "utf8" }).trim();
}

/** Return stable, non-identifying hardware facts suitable for benchmark evidence. */
export function machineClass() {
  const processors = cpus();
  const machine = {
    platform: process.platform,
    architecture: process.arch,
    chip: processors[0]?.model || "unknown",
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    logicalCores: processors.length,
  };
  if (process.platform === "darwin") {
    return {
      ...machine,
      modelIdentifier: sysctl("hw.model"),
      chip: sysctl("machdep.cpu.brand_string"),
      memoryGiB: Math.round(Number(sysctl("hw.memsize")) / 1024 ** 3),
      logicalCores: Number(sysctl("hw.ncpu")),
    };
  }
  return machine;
}
