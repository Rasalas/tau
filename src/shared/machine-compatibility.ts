import { HOST_ERROR } from "./host-transport.js";

export const MACHINE_KIT_NAMES: Readonly<Record<string, string>> = {
  "tau.workspace": "Workspace Kit", "tau.files": "Files", "tau.terminal": "Terminal", "tau.review": "Review Kit",
};

/** Only an absent remote feature asks for an update; installed but inactive kits keep their own failure. */
export function machineKitError(error: unknown, machine: string, extensionId: string, command: string): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const kit = MACHINE_KIT_NAMES[extensionId];
  if (!kit) return error;
  const message = error instanceof Error ? error.message : String(error);
  const missing = code === HOST_ERROR.unknownMethod || code === HOST_ERROR.unknownExtension || code === HOST_ERROR.unknownCommand
    || code === HOST_ERROR.failed && (
      message === `Host extension ${extensionId} is not installed.`
      || message === `Host extension ${kit} has no command "${command}".`
    );
  return missing ? Object.assign(new Error(`${machine} has no ${kit} that can do this yet. Update ${machine}.`, { cause: error }), { code, expected: true }) : error;
}

/** Notices carry text only. Recognize the complete sentences our compatibility callers produce, before headline truncation. */
export function isMachineUpdateNotice(message: string): boolean {
  return /^(.+) runs an older Tau that cannot (take messages from here|start threads|rename threads from here|take images from here|change models from here) yet\. Update \1 in Settings → Machines\.$/u.test(message)
    || /^(.+) has no (Workspace Kit|Files|Terminal|Review Kit) that can do this yet\. Update \1\.$/u.test(message);
}
