import type { HostLogger } from "./host-log.js";

export function installHostProcessErrorHandlers(log: HostLogger): void {
  process.on("uncaughtException", (error) => {
    log.error("process.uncaughtException", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    // A rejected background task must not end the other threads' turns.
    log.error("process.unhandledRejection", reason);
  });
}
