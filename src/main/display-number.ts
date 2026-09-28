import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { FIRST_DISPLAY_NUMBER } from "./host-service-units.js";

/** Past this, something else owns every display number Tau would try. */
export const LAST_DISPLAY_NUMBER = FIRST_DISPLAY_NUMBER + 100;

/** What says whether a display number is free; tests pass their own. */
export interface DisplayProbe {
  exists(path: string): boolean;
  readFile(path: string): string | undefined;
  alive(pid: number): boolean;
  /** Displays with a listening abstract X socket. */
  listening: ReadonlySet<number>;
  processes: readonly { pid: number; args: readonly string[] }[];
}

const X_SERVER = /^X(?:vfb|org|wayland|vnc|ephyr|nest|tigervnc)?$/u;

/** Why display `:N` is not free, or undefined. A lock whose pid is gone still counts: its owner may be starting. */
export function displayInUse(number: number, probe: DisplayProbe): string | undefined {
  const lock = `/tmp/.X${number}-lock`;
  if (probe.exists(lock)) {
    const pid = Number.parseInt(probe.readFile(lock)?.trim() ?? "", 10);
    return Number.isNaN(pid) ? lock : `${lock} (pid ${pid}, ${probe.alive(pid) ? "running" : "not running"})`;
  }
  const socket = `/tmp/.X11-unix/X${number}`;
  if (probe.exists(socket)) return socket;
  if (probe.listening.has(number)) return `abstract socket @${socket}`;
  const server = probe.processes.find((process) => X_SERVER.test(basename(process.args[0] ?? "")) && process.args.includes(`:${number}`));
  return server ? `X server pid ${server.pid} (${server.args.join(" ")})` : undefined;
}

/** The first number nothing claims, and why each one before it was skipped. */
export function firstFreeDisplay(inUse: (number: number) => string | boolean | undefined, first = FIRST_DISPLAY_NUMBER, last = LAST_DISPLAY_NUMBER): { number?: number; skipped: { number: number; reason: string }[] } {
  const skipped: { number: number; reason: string }[] = [];
  for (let number = first; number <= last; number++) {
    const reason = inUse(number);
    if (!reason) return { number, skipped };
    skipped.push({ number, reason: reason === true ? "in use" : reason });
  }
  return { skipped };
}

/**
 * Displays with an abstract X socket. A container that shares the network
 * namespace has its own `/tmp` but the same abstract sockets, so the files alone miss them.
 */
export function abstractX11Displays(socketTable: string): Set<number> {
  return new Set([...socketTable.matchAll(/ @\/tmp\/\.X11-unix\/X(\d+)$/gmu)].map((match) => Number(match[1])));
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** This machine now: `/tmp`, `/proc/net/unix` and every process's command line. */
export function linuxDisplayProbe(): DisplayProbe {
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/u.test(name));
  } catch {
    // no /proc
  }
  const processes = pids.flatMap((pid) => {
    const args = readText(`/proc/${pid}/cmdline`)?.split("\0").filter(Boolean);
    return args && args.length > 0 ? [{ pid: Number(pid), args }] : [];
  });
  return {
    exists: existsSync,
    readFile: readText,
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    listening: abstractX11Displays(readText("/proc/net/unix") ?? ""),
    processes,
  };
}
