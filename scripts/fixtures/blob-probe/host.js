// Test-only package for smoke:remote-work and the real check of H02: on A it
// sends a file to another machine through services.machines.upload, on that
// machine it takes it once through services.blobs. Remote Work Kit (H05) is
// the real caller.
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";

const ID = "test.blob-probe";

export default {
  id: ID,
  name: "Blob probe",
  activate(context) {
    const { machines, blobs } = context.services;
    context.registerCommand("take", async (input, call) => blobs.take(input.id, (blob) => ({
      sha256: createHash("sha256").update(readFileSync(blob.path)).digest("hex"),
      size: blob.size,
      path: blob.path,
      device: blob.device ?? null,
    }), { caller: call }));
    context.registerCommand("send", async (input) => {
      const size = statSync(input.path).size;
      const started = Date.now();
      const progress = [];
      const sent = await machines.upload(input.machine, createReadStream(input.path), { size, onProgress: (step) => progress.push(step.sent) });
      const ms = Date.now() - started;
      const taken = await machines.call(input.machine, ID, "take", { id: sent.id });
      const again = await machines.call(input.machine, ID, "take", { id: sent.id }).then(() => "taken twice", (error) => String(error.message));
      return { sent, ms, progress, taken, again };
    }, { long: true });
  },
};
