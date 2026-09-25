import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { UiPairingRequest } from "../shared/connections.js";
import { formatVerification } from "../shared/pairing.js";
import type { HostAccess } from "./host-access.js";
import { deviceLabel } from "./client-device.js";

function describe(request: UiPairingRequest): string {
  const who = request.name ?? request.link?.label ?? deviceLabel(request.device);
  const how = request.link ? "with a pairing link" : "without a pairing link";
  const agents = request.companion ? `, and its agents as “${request.companion.name}”` : "";
  return `${who} (${deviceLabel(request.device)}${request.address ? `, from ${request.address}` : ""}, ${how})${agents}`;
}

/**
 * Asks on the terminal a hand-started host runs in, one request at a time:
 * the owner compares the digits with the device's and answers. Answers the
 * function the host calls whenever access changed.
 */
export function promptPairingsOnTerminal(access: HostAccess, io: { input: Readable; output: Writable }): () => void {
  // Not a terminal readline: Ctrl+C stays the process's SIGINT.
  const lines = createInterface({ input: io.input, terminal: false });
  const asked = new Set<string>();
  let current: UiPairingRequest | undefined;

  const next = (): void => {
    const waiting = access.overview().requests;
    if (current && !waiting.some((request) => request.id === current!.id)) {
      io.output.write("\n(That request ended before an answer.)\n");
      current = undefined;
    }
    if (current) return;
    current = waiting.find((request) => !asked.has(request.id));
    if (!current) return;
    asked.add(current.id);
    io.output.write(`\nPairing request: ${describe(current)}\n`
      + `  Code ${formatVerification(current.verification)}: allow it only if the device shows the same code.\n`
      + `  Allow? [f]ull access / [r]ead only / [N]o: `);
  };

  lines.on("line", (line) => {
    const request = current;
    if (!request) return;
    current = undefined;
    const answer = line.trim().toLowerCase();
    const chosen = answer === "f" || answer === "full" ? "full" : answer === "r" || answer === "read only" ? "read-only" : undefined;
    const done = chosen
      ? access.approvePairing(request.id, { access: chosen }).then((ok) => (ok ? `Allowed (${chosen === "full" ? "full access" : "read only"}).` : "The device had stopped waiting."))
      : Promise.resolve(access.denyPairing(request.id) ? "Denied." : "The device had stopped waiting.");
    void done.then((message) => io.output.write(`${message}\n`), (error: unknown) => io.output.write(`Could not allow it: ${String(error)}\n`)).then(next);
  });
  return next;
}
