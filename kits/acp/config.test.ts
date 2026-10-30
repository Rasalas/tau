import { expect, it } from "vitest";
import { packageAgent, parseAgent, parseRegistry } from "./config.js";
import { MUSE } from "./protocol.js";
import { safeArchivePath } from "./install.js";

it("keeps launch arguments literal and validates custom identities and environment", () => {
  expect(parseAgent({ ...MUSE, args: ["acp", "$(do not execute)"] }).args).toEqual(["acp", "$(do not execute)"]);
  for (const id of ["../escape", "x@y", "", "Upper"]) expect(() => parseAgent({ ...MUSE, id })).toThrow();
  expect(() => parseAgent({ ...MUSE, env: { "BAD NAME": "x" } })).toThrow();
  expect(() => parseAgent({ ...MUSE, args: "--acp" })).toThrow();
});
it("uses the registry's package version and arguments without shell expansion", () => {
  const agent = parseRegistry({ agents: [{ id: "cline", name: "Cline", version: "3.0.74", description: "Agent", distribution: { npx: { package: "cline@3.0.74", args: ["--acp"] } } }] })[0]!;
  expect(packageAgent(agent)).toMatchObject({ command: "npx", args: ["--yes", "--", "cline@3.0.74", "--acp"] });
  expect(() => packageAgent({ ...agent, distribution: { npx: { package: "--help; touch nope" } } })).toThrow();
  expect(() => parseRegistry({ agents: [agent, agent] })).toThrow();
});
it("refuses paths that escape a binary installation", () => {
  expect(safeArchivePath("/tmp/install", "./bin/agent")).toBe("/tmp/install/bin/agent");
  for (const path of ["/etc/passwd", "../escape", "a/../../escape", "C:\\escape", "a\\escape"]) expect(() => safeArchivePath("/tmp/install", path)).toThrow();
});

it("supports versioned Python agents from the official registry", () => {
  const agent = { id: "fast-agent", name: "Fast Agent", version: "0.10.1", description: "Agent", distribution: { uvx: { package: "fast-agent-acp==0.10.1", args: ["-x"] } } };
  expect(packageAgent(agent)).toMatchObject({ command: "uvx", args: ["--", "fast-agent-acp==0.10.1", "-x"] });
});
