import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeAgentPiThread, piTargets } from "../../scripts/compare/thread-switch.mjs";
import { testHostDir } from "../../scripts/tau-test-host.mjs";

export const defaultTargets = () => piTargets().filter((target) => target.size !== "medium").map(({ size, title, text, turns }) => ({ size, title, text, turns }));

/** Uses the comparison's session writer; it writes history and never starts a turn. */
export async function seedFixtures(root, hostName) {
  const dir = join(root, ".tau-dev", "mobile-measure");
  const manifest = join(dir, "targets.json");
  if (existsSync(manifest)) throw new Error("Mobile fixtures already exist; reuse them or remove their sessions and targets.json first");
  const cwd = join(dir, "workspace");
  const sessionDir = hostName ? join(testHostDir(hostName, root), "pi-sessions") : join(root, ".tau-dev", "pi-sessions");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  const targets = defaultTargets();
  const now = Date.now();
  const sessions = [];
  for (const [index, target] of [...targets, { title: "Mobile starter thread", turns: 1 }].entries()) {
    sessions.push(await writeAgentPiThread(root, { cwd, sessionDir, title: target.title, turns: target.turns, endsAt: now - (2 - index) * 60_000, checkpoints: false }));
  }
  writeFileSync(manifest, `${JSON.stringify(targets, null, 2)}\n`, { flag: "wx" });
  writeFileSync(join(dir, "sessions.json"), `${JSON.stringify(sessions, null, 2)}\n`, { flag: "wx" });
  return { targets: manifest, workspace: cwd, sessionDir };
}
