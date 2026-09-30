import { execFileSync } from "node:child_process";
import { createFirestoreDocument } from "./firestore.mjs";

// The deployer changes only the revision fence, never reads the enrollment secret.
export async function fenceRevision(document, revision) {
  if (!/^tau-connect-[a-z0-9-]{1,50}$/u.test(revision ?? "")) throw new Error("Invalid Connect revision.");
  return document.update((state) => {
    const previous = state.allowedRevision;
    state.allowedRevision = revision;
    // Preserve the old lease. Its forwarding deadline ends before a replacement
    // can acquire it, even if the old process cannot observe the fence immediately.
    return previous;
  });
}

if (process.argv[1]?.endsWith("/cloud-state.mjs")) {
  const document = createFirestoreDocument({
    project: "tau-push-e3c95", database: "tau-connect",
    tokenProvider: async () => execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
  });
  const { result } = await fenceRevision(document, process.argv[2]);
  console.log(JSON.stringify({ previousRevision: result }));
}
